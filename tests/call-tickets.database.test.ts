import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { beforeAll, afterAll, describe, expect, it } from "vitest"

const migration = (name: string) =>
  readFileSync(`supabase/migrations/${name}.sql`, "utf8")
let db: PGlite
let sequence = 0
const candidate = () => ({
  code_hash: `hash-${++sequence}`,
  code_ciphertext: "encrypted-test-fixture",
  code_last4: "TEST",
})
async function value(sql: string, args: unknown[] = []) {
  return (await db.query<{ result: any }>(sql, args)).rows[0]?.result
}
async function host(mode = "free", max = 1) {
  const id = await value(
    "insert into hosts(display_name) values('Ticket Host') returning id as result",
  )
  const next = candidate()
  await value("select configure_call_ticket($1,$2,$3,$4) as result", [
    id,
    next,
    mode,
    max,
  ])
  return { id, hash: next.code_hash }
}
async function reserve(
  hash: string,
  email = `caller-${++sequence}@example.test`,
  attempt = `attempt-${++sequence}`,
) {
  return value(
    "select begin_ticket_session($1,'audio',$2,$3,'tokenhash') as result",
    [
      hash,
      { fullName: "Ticket Caller", email, phone: "+2348000000000" },
      attempt,
    ],
  )
}
async function transition(
  id: string,
  status: string,
  reason: string | null = null,
) {
  return value(
    "select transition_call_session($1,$2,null,null,$3,$4) as result",
    [id, status, reason, candidate()],
  )
}
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create function auth.role() returns text language sql as $$ select 'service_role'::text $$;`)
  const core = migration("20260926170000_callastar_core").replace(
    "create extension if not exists pgcrypto;",
    "",
  )
  await db.exec(
    core.slice(0, core.indexOf("alter table public.admin_profiles enable")),
  )
  const foundation = migration("20261007100000_backend_foundation")
  await db.exec(
    foundation.slice(
      0,
      foundation.indexOf(
        "create table if not exists public.profile_engagement",
      ),
    ),
  )
  await db.exec(`create table subscription_plans(id text primary key,display_name text,session_duration_minutes integer,is_active boolean default true);
    create table call_access_grants(id text primary key,plan_id text references subscription_plans(id),customer_email_normalized text,status text default 'active',consumed_by_session_id text,consumed_at timestamptz,granted_at timestamptz default now());`)
  const trials = migration("20261008100000_trial_receipts_and_call_preflight")
  await db.exec(
    trials.slice(trials.indexOf("alter table public.call_sessions add column")),
  )
  // Apply the actual forward migration, not a test copy of its functions.
  await db.exec(migration("20261020100000_controlled_call_tickets"))
  await db.exec(migration("20261020120000_source_completion_tickets"))
  await db.exec(migration("20261020130000_source_video_interruptions"))
}, 60000)
afterAll(async () => {
  await db?.close()
})

describe("authoritative call tickets (PostgreSQL)", () => {
  it("persists interruption ranges on the specific uploaded source asset", async () => {
    const profile = await host()
    await db.query(`insert into host_assets(id,host_id,kind,storage_path,file_name,mime_type,file_size_bytes,duration_seconds)
      values ('source-video-a',$1,'remote_video','source/a.mp4','a.mp4','video/mp4',10,20),
             ('source-video-b',$1,'remote_video','source/b.mp4','b.mp4','video/mp4',10,20)`, [profile.id])
    const ranges = [{ startMs: 5000, endMs: 7000, type: "connection" }]
    await db.query("update host_assets set interruptions=$1::jsonb where id='source-video-a'", [JSON.stringify(ranges)])
    const stored = await db.query<{ id: string; interruptions: unknown }>("select id,interruptions from host_assets order by id")
    expect(stored.rows).toEqual([
      { id: "source-video-a", interruptions: ranges },
      { id: "source-video-b", interruptions: [] },
    ])
    await expect(db.query("update host_assets set interruptions='{}'::jsonb where id='source-video-a'")).rejects.toThrow()
  })

  it.each([1, 2, 3, 5])(
    "consumes exactly %i successful calls and rotates once",
    async (max) => {
      const h = await host("free", max)
      for (let i = 1; i <= max; i++) {
        const s = await reserve(h.hash)
        expect(s.kind).toBe("free")
        expect(await transition(s.sessionId, "active")).toBe(true)
        expect(await transition(s.sessionId, "active")).toBe(true)
        expect(
          await value(
            "select use_count as result from call_ids where code_hash=$1",
            [h.hash],
          ),
        ).toBe(i)
        await transition(s.sessionId, "ended", "SOURCE_VIDEO_ENDED")
      }
      expect((await reserve(h.hash)).code).toBe("CALL_ID_EXHAUSTED")
      expect(
        await value(
          "select count(*)::int as result from call_ids where host_id=$1 and status='active'",
          [h.id],
        ),
      ).toBe(1)
      expect(
        await value(
          "select use_count as result from call_ids where host_id=$1 and status='active'",
          [h.id],
        ),
      ).toBe(0)
    },
  )
  it("allows one reservation under competing submissions", async () => {
    const h = await host()
    const results = await Promise.all([reserve(h.hash), reserve(h.hash)])
    expect(results.filter((r) => r.sessionId)).toHaveLength(1)
    expect(results.find((r) => r.code)?.code).toBe(
      "CALL_ID_TEMPORARILY_RESERVED",
    )
    expect(
      await value(
        "select use_count as result from call_ids where code_hash=$1",
        [h.hash],
      ),
    ).toBe(0)
  })
  it.each(["declined", "failed", "no_answer", "cancelled"])(
    "releases %s without consumption",
    async (status) => {
      const h = await host()
      const s = await reserve(h.hash)
      expect(await transition(s.sessionId, status)).toBe(true)
      expect((await reserve(h.hash)).sessionId).toBeTruthy()
    },
  )
  it("reclaims an expired reservation and prevents late activation", async () => {
    const h = await host()
    const s = await reserve(h.hash)
    await db.query(
      "update call_sessions set ticket_reserved_until=now()-interval '1 second' where id=$1",
      [s.sessionId],
    )
    expect((await reserve(h.hash)).sessionId).toBeTruthy()
    expect(await transition(s.sessionId, "active")).toBe(false)
  })
  it("free mode bypasses a consumed Premium bonus", async () => {
    const premium = await host("premium")
    const email = "  Bonus@Example.test "
    const s = await reserve(premium.hash, email)
    expect(s.kind).toBe("premium_bonus")
    await transition(s.sessionId, "active")
    const free = await host()
    expect((await reserve(free.hash, "bonus@example.test")).kind).toBe("free")
    const returning = await host("premium")
    expect((await reserve(returning.hash, "BONUS@example.test")).code).toBe(
      "PREMIUM_SUBSCRIPTION_REQUIRED",
    )
    expect(
      await value(
        "select use_count as result from call_ids where code_hash=$1",
        [returning.hash],
      ),
    ).toBe(0)
    await db.exec(
      "insert into subscription_plans values('plus','Plus',20,true); insert into call_access_grants(id,plan_id,customer_email_normalized) values('paid-grant','plus','bonus@example.test');",
    )
    const paid = await reserve(returning.hash, "bonus@example.test")
    expect(paid.kind).toBe("paid")
    await transition(paid.sessionId, "declined")
    expect((await reserve(returning.hash, "bonus@example.test")).kind).toBe(
      "paid",
    )
  })
  it("does not consume the Premium bonus before actual activation", async () => {
    const h = await host("premium")
    const email = "release@example.test"
    const s = await reserve(h.hash, email)
    await transition(s.sessionId, "declined")
    expect((await reserve(h.hash, email)).kind).toBe("premium_bonus")
  })
  it("rotates on mode change and preserves the authorized in-flight mode", async () => {
    const h = await host()
    const s = await reserve(h.hash)
    await value("select configure_call_ticket($1,$2,'premium') as result", [
      h.id,
      candidate(),
    ])
    expect((await reserve(h.hash)).code).toBe("CALL_ID_RETIRED")
    expect(await transition(s.sessionId, "active")).toBe(true)
    expect(
      await value(
        "select mode_at_start as result from call_sessions where id=$1",
        [s.sessionId],
      ),
    ).toBe("free")
  })
  it("changes limits safely and rotates when the new limit is reached", async () => {
    const h = await host("free", 5)
    for (let i = 0; i < 2; i++) {
      const s = await reserve(h.hash)
      await transition(s.sessionId, "active")
    }
    await value("select configure_call_ticket($1,$2,null,3) as result", [
      h.id,
      candidate(),
    ])
    expect(
      await value(
        "select max_uses as result from call_ids where code_hash=$1",
        [h.hash],
      ),
    ).toBe(3)
    await value("select configure_call_ticket($1,$2,null,2) as result", [
      h.id,
      candidate(),
    ])
    expect((await reserve(h.hash)).code).toBe("CALL_ID_EXHAUSTED")
    expect(
      await value(
        "select max_uses as result from call_ids where host_id=$1 and status='active'",
        [h.id],
      ),
    ).toBe(2)
  })
  it("rejects invalid modes, limits and inactive profiles", async () => {
    const h = await host()
    await expect(
      value("select configure_call_ticket($1,$2,'both') as result", [
        h.id,
        candidate(),
      ]),
    ).rejects.toThrow("INVALID_MODE")
    await expect(
      value("select configure_call_ticket($1,$2,null,4) as result", [
        h.id,
        candidate(),
      ]),
    ).rejects.toThrow("INVALID_MAX_USES")
    await db.query("update hosts set status='inactive' where id=$1", [h.id])
    expect((await reserve(h.hash)).code).toBe("PROFILE_UNAVAILABLE")
  })
  it("binds idempotent retries to the original customer", async () => {
    const h = await host()
    const a = await reserve(h.hash, "owner@example.test", "same-attempt")
    expect(
      (await reserve(h.hash, "owner@example.test", "same-attempt")).sessionId,
    ).toBe(a.sessionId)
    expect(
      (await reserve(h.hash, "other@example.test", "same-attempt")).code,
    ).toBe("INVALID_CALL_SESSION")
  })
  it("manual regeneration preserves the configured mode and limit", async () => {
    const h = await host("free", 3)
    await value(
      "select configure_call_ticket($1,$2,null,null,true) as result",
      [h.id, candidate()],
    )
    expect((await reserve(h.hash)).code).toBe("CALL_ID_RETIRED")
    expect(
      await value(
        "select jsonb_build_array(issued_mode,max_uses,use_count) as result from call_ids where host_id=$1 and status='active'",
        [h.id],
      ),
    ).toEqual(["free", 3, 0])
  })
  it("never rotates twice when activation is retried", async () => {
    const h = await host()
    const s = await reserve(h.hash)
    await transition(s.sessionId, "active")
    await transition(s.sessionId, "active")
    expect(
      await value(
        "select count(*)::int as result from call_ids where host_id=$1",
        [h.id],
      ),
    ).toBe(2)
    await transition(s.sessionId, "ended", "SOURCE_VIDEO_ENDED")
    expect(
      await value(
        "select end_reason as result from call_sessions where id=$1",
        [s.sessionId],
      ),
    ).toBe("SOURCE_VIDEO_ENDED")
  })
  it("rejects a video attempt without a selected usable source before reserving", async () => {
    const h = await host()
    const result = await value(
      "select begin_ticket_session($1,'video',$2,'missing-source','token') as result",
      [
        h.hash,
        {
          fullName: "Caller",
          email: "source@example.test",
          phone: "123456789",
        },
      ],
    )
    expect(result.code).toBe("SOURCE_MEDIA_UNAVAILABLE")
    expect(
      await value(
        "select count(*)::int as result from call_sessions where host_id=$1",
        [h.id],
      ),
    ).toBe(0)
  })
  it("Free sessions do not create a Premium eligibility ledger entry", async () => {
    const h = await host()
    const s = await reserve(h.hash, "free-only@example.test")
    await transition(s.sessionId, "active")
    expect(
      await value(
        "select count(*)::int as result from call_trial_eligibility where customer_email_normalized='free-only@example.test'",
      ),
    ).toBe(0)
  })
  it("gives a first-time Premium caller their bonus before claiming paid access", async () => {
    const h = await host("premium")
    await db.exec(
      "insert into subscription_plans values('pro','Pro',30,true); insert into call_access_grants(id,plan_id,customer_email_normalized) values('first-paid-grant','pro','first-paid@example.test');",
    )
    const s = await reserve(h.hash, "first-paid@example.test")
    expect(s.kind).toBe("premium_bonus")
    expect(
      await value(
        "select consumed_by_session_id as result from call_access_grants where id='first-paid-grant'",
      ),
    ).toBeNull()
  })
  it("scopes mutation RPCs and counters to service_role", async () => {
    expect(
      await value(
        "select has_function_privilege('anon','public.begin_ticket_session(text,text,jsonb,text,text)','EXECUTE') as result",
      ),
    ).toBe(false)
    expect(
      await value(
        "select has_function_privilege('authenticated','public.configure_call_ticket(uuid,jsonb,text,integer,boolean)','EXECUTE') as result",
      ),
    ).toBe(false)
    expect(
      await value(
        "select has_column_privilege('authenticated','public.hosts','profile_mode','UPDATE') as result",
      ),
    ).toBe(false)
    expect(
      await value(
        "select has_column_privilege('authenticated','public.hosts','status','UPDATE') as result",
      ),
    ).toBe(true)
  })
})

it("binds a reservation to only one signaling attempt and rejects mismatched or expired tickets", async () => {
  const h = await host(); const session = await reserve(h.hash);
  expect(await value("select bind_ticket_signaling($1,'wrong-hash','att_11111111') as result",[session.sessionId])).toBeNull();
  const first = await value("select bind_ticket_signaling($1,$2,'att_11111111') as result",[session.sessionId,h.hash]);
  const retry = await value("select bind_ticket_signaling($1,$2,'att_22222222') as result",[session.sessionId,h.hash]);
  expect(first.callAttemptId).toBe("att_11111111"); expect(retry.callAttemptId).toBe(first.callAttemptId);
  await transition(session.sessionId,"active");
  expect(await value("select bind_ticket_signaling($1,$2,'att_33333333') as result",[session.sessionId,h.hash])).toBeNull();
});

// Video tickets use completion accounting; audio/previous sessions keep their
// existing activation contract above. Run these against the forward SQL itself.
async function sourceHost(mode = "free", max = 1) {
  const h = await host(mode, max);
  const asset = "source-" + (++sequence);
  await db.query("insert into host_assets(id,host_id,kind,storage_path,file_name,mime_type,file_size_bytes,duration_seconds,width,height) values($1,$2,'remote_video',$1,'source.mp4','video/mp4',1000,30,640,360)", [asset,h.id]);
  await db.query("update hosts set remote_video_asset_id=$1 where id=$2", [asset,h.id]);
  return {...h,asset};
}
async function reserveSource(hash: string, email = "source-"+(++sequence)+"@example.test") {
  return value("select begin_ticket_session($1,'video',$2,$3,'token') as result", [hash,{fullName:"Caller",email,phone:"123456789"},"source-attempt-"+(++sequence)]);
}
async function ticket(hash: string) {
  return value("select jsonb_build_object('uses',use_count,'status',status,'next',replaced_by_call_id) as result from call_ids where code_hash=$1",[hash]);
}
describe("source-video completion accounting", () => {
  it("allows a Free source call after the same email has consumed its Premium bonus", async () => {
    const email = "returning-source-caller@example.test";
    const premium = await sourceHost("premium");
    const bonus = await reserveSource(premium.hash, email);
    await transition(bonus.sessionId, "active");
    await transition(bonus.sessionId, "ended", "SOURCE_VIDEO_ENDED");
    const free = await sourceHost("free");
    const session = await reserveSource(free.hash, email);
    expect(session.kind).toBe("free");
    expect(await transition(session.sessionId, "active")).toBe(true);
    expect(await ticket(free.hash)).toMatchObject({ uses: 0, status: "active" });
    expect(await transition(session.sessionId, "ended", "SOURCE_VIDEO_ENDED")).toBe(true);
    expect(await value("select state as result from call_trial_eligibility where customer_email_normalized=$1", [email])).toBe("consumed");
  });
  it("preserves an in-flight Free source when its host switches to Premium", async () => {
    const h = await sourceHost("free", 3);
    const session = await reserveSource(h.hash);
    await value("select configure_call_ticket($1,$2,'premium',2) as result", [h.id, candidate()]);
    expect((await reserveSource(h.hash)).code).toBe("CALL_ID_RETIRED");
    expect(await transition(session.sessionId, "active")).toBe(true);
    expect(await ticket(h.hash)).toMatchObject({ uses: 0, status: "manually_retired" });
    expect(await transition(session.sessionId, "ended", "SOURCE_VIDEO_ENDED")).toBe(true);
    expect(await ticket(h.hash)).toMatchObject({ uses: 1, status: "manually_retired" });
    expect(await value("select jsonb_build_array(issued_mode,max_uses,use_count) as result from call_ids where host_id=$1 and status='active'", [h.id])).toEqual(["premium", 2, 0]);
  });
  it.each([1,2,3,5])("holds reservations through active playback and consumes %i natural completions", async max => {
    const h = await sourceHost("free",max);
    for (let i=0;i<max;i++) {
      const s = await reserveSource(h.hash);
      expect(s.kind).toBe("free");
      expect(s.deliveryKind).toBe("source_video");
      expect(await transition(s.sessionId,"ringing")).toBe(true);
      expect(await transition(s.sessionId,"active")).toBe(true);
      expect(await transition(s.sessionId,"active")).toBe(true);
      expect(await ticket(h.hash)).toMatchObject({uses:i,status:"active",next:null});
      expect(await value("select ticket_consumed_at as result from call_sessions where id=$1",[s.sessionId])).toBeNull();
      expect(await value("select renew_ticket_session($1) as result",[s.sessionId])).toBe(true);
      expect(await transition(s.sessionId,"ended","SOURCE_VIDEO_ENDED")).toBe(true);
      expect(await transition(s.sessionId,"ended","SOURCE_VIDEO_ENDED")).toBe(true);
      expect(await ticket(h.hash)).toMatchObject({uses:i+1,status:i+1===max?"exhausted":"active"});
    }
    expect((await reserveSource(h.hash)).code).toBe("CALL_ID_EXHAUSTED");
    expect(await value("select count(*)::int as result from call_ids where host_id=$1",[h.id])).toBe(2);
    expect(await value("select jsonb_build_array(issued_mode,max_uses,use_count) as result from call_ids where host_id=$1 and status='active'",[h.id])).toEqual(["free",max,0]);
  });
  it("admits only one concurrent final-slot reservation, including while its source is active", async () => {
    const h=await sourceHost();
    const attempts=await Promise.all(Array.from({length:8},()=>reserveSource(h.hash)));
    const winner=attempts.find(s=>s.sessionId);
    expect(attempts.filter(s=>s.sessionId)).toHaveLength(1);
    expect(attempts.filter(s=>s.code==="CALL_ID_TEMPORARILY_RESERVED")).toHaveLength(7);
    await transition(winner.sessionId,"active");
    expect((await reserveSource(h.hash)).code).toBe("CALL_ID_TEMPORARILY_RESERVED");
    await transition(winner.sessionId,"ended","USER_ENDED");
    expect(await ticket(h.hash)).toMatchObject({uses:0,status:"active"});
    expect((await reserveSource(h.hash)).sessionId).toBeTruthy();
  });
  it.each(["declined","no_answer","cancelled","failed"])("releases %s attempts before playback", async status=>{
    const h=await sourceHost(); const s=await reserveSource(h.hash);
    expect(await transition(s.sessionId,status,status)).toBe(true);
    expect(await ticket(h.hash)).toMatchObject({uses:0,status:"active",next:null});
    expect((await reserveSource(h.hash)).sessionId).toBeTruthy();
  });
  it.each(["USER_ENDED","source_unavailable","connection_failed"])("releases an active source on %s without spending a use", async reason=>{
    const h=await sourceHost();const s=await reserveSource(h.hash);
    await transition(s.sessionId,"active");
    await transition(s.sessionId,reason==="USER_ENDED"?"ended":"failed",reason);
    expect(await ticket(h.hash)).toMatchObject({uses:0,status:"active"});
    expect(await value("select ticket_reserved_until as result from call_sessions where id=$1",[s.sessionId])).toBeNull();
    expect(await value("select end_reason as result from call_sessions where id=$1",[s.sessionId])).toBe(reason);
    expect((await reserveSource(h.hash)).sessionId).toBeTruthy();
  });
  it("rejects completion without activation and cannot revive expired active leases",async()=>{
    const h=await sourceHost();const s=await reserveSource(h.hash);
    expect(await transition(s.sessionId,"ended","SOURCE_VIDEO_ENDED")).toBe(false);
    await transition(s.sessionId,"active");
    await db.query("update call_sessions set ticket_reserved_until=now()-interval '1 second' where id=$1",[s.sessionId]);
    expect(await value("select renew_ticket_session($1) as result",[s.sessionId])).toBe(false);
    expect(await transition(s.sessionId,"ended","SOURCE_VIDEO_ENDED")).toBe(false);
    expect(await ticket(h.hash)).toMatchObject({uses:0,status:"active"});
    expect((await reserveSource(h.hash)).sessionId).toBeTruthy();
  });
  it("preserves normalized Premium bonus eligibility on early end and consumes it only on natural completion",async()=>{
    const h=await sourceHost("premium",2);const email="Completion.Bonus@example.test";
    let s=await reserveSource(h.hash," "+email+" ");
    expect(s.kind).toBe("premium_bonus");await transition(s.sessionId,"active");
    expect(await value("select state as result from call_trial_eligibility where reserved_session_id=$1",[s.sessionId])).toBe("reserved");
    await transition(s.sessionId,"ended","USER_ENDED");
    s=await reserveSource(h.hash,email.toLowerCase());expect(s.kind).toBe("premium_bonus");
    await transition(s.sessionId,"active");await transition(s.sessionId,"ended","SOURCE_VIDEO_ENDED");
    expect((await reserveSource(h.hash,email.toLowerCase())).code).toBe("PREMIUM_SUBSCRIPTION_REQUIRED");
    expect(await ticket(h.hash)).toMatchObject({uses:1,status:"active"});
  });
  it("releases paid entitlement on active media failure and retains it on successful completion",async()=>{
    const h=await sourceHost("premium",2);const email="completion-paid@example.test";
    await db.query("insert into call_trial_eligibility(customer_email_normalized,state,consumed_session_id,consumed_at) values($1,'consumed',(select id from call_sessions limit 1),now())",[email]);
    await db.exec("insert into subscription_plans values('completion-plus','Plus',20,true)");
    await db.query("insert into call_access_grants(id,plan_id,customer_email_normalized) values('completion-grant','completion-plus',$1)",[email]);
    let s=await reserveSource(h.hash,email);expect(s.kind).toBe("paid");
    await transition(s.sessionId,"active");await transition(s.sessionId,"failed","source_unavailable");
    s=await reserveSource(h.hash,email);expect(s.kind).toBe("paid");
    await transition(s.sessionId,"active");await transition(s.sessionId,"ended","SOURCE_VIDEO_ENDED");
    expect((await reserveSource(h.hash,email)).code).toBe("PREMIUM_SUBSCRIPTION_REQUIRED");
  });
  it("keeps availability independent of both modes and snapshots the intended source",async()=>{
    for(const mode of ["free","premium"]) {
      const h=await sourceHost(mode);await db.query("update hosts set status='inactive' where id=$1",[h.id]);
      expect((await reserveSource(h.hash)).code).toBe("PROFILE_UNAVAILABLE");
      await db.query("update hosts set status='active' where id=$1",[h.id]);
      const s=await reserveSource(h.hash);expect(s.sessionId).toBeTruthy();
      await db.query("update hosts set remote_video_asset_id=null where id=$1",[h.id]);
      expect(await value("select source_asset_id as result from call_sessions where id=$1",[s.sessionId])).toBe(h.asset);
      await transition(s.sessionId,"active");await transition(s.sessionId,"ended","SOURCE_VIDEO_ENDED");
      expect(await ticket(h.hash)).toMatchObject({uses:1,status:"exhausted"});
    }
  });
});
