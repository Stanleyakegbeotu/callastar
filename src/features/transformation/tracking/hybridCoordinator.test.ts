import { describe, expect, it } from 'vitest';
import { DEFAULT_HYBRID_FLAGS, HybridCoordinator } from './hybridCoordinator';
import type { TrackerSample } from './trackerProvider';
const sample = (timestamp=1000, extra: Partial<TrackerSample>={}): TrackerSample => ({provider:'jeeliz',timestamp,confidence:.95,detected:true,stale:false,frameAgeMs:20,...extra}) as TrackerSample;
const primary = {eyes:null,pose:{yaw:.1,pitch:.2,roll:.3},detected:true,confidence:.8};
describe('M8.6 conservative hybrid coordinator', () => {
  it('disables every assist flag by default and preserves primary controls', () => {
    expect(DEFAULT_HYBRID_FLAGS).toEqual({enabled:false,poseAssist:false,reacquisitionAssist:false});
    const c=new HybridCoordinator(); c.observe(sample()); const out=c.resolve(primary,1100);
    expect(out.pose).toBe(primary.pose); expect(out.eyes).toBe(primary.eyes); expect(out.globalConfidence).toBeNull();
  });
  it('confirms only consecutive fresh detections and never invents an eye', () => {
    const c=new HybridCoordinator({enabled:true,poseAssist:false,reacquisitionAssist:true});
    c.observe(sample()); expect(c.resolve(primary,1100).reacquisitionConfirmed).toBe(false);
    c.observe(sample(1200)); const out=c.resolve(primary,1250);
    expect(out.reacquisitionConfirmed).toBe(true); expect(out.eyes).toBeNull(); expect(out.pose).toBe(primary.pose);
    expect(c.resolve({...primary,detected:false},1250).reacquisitionConfirmed).toBe(false);
  });
  it('falls back for stale, old, low-confidence or missing assistant data', () => {
    const c=new HybridCoordinator({enabled:true,poseAssist:false,reacquisitionAssist:true});
    c.observe(sample()); c.observe(sample(1200));
    expect(c.resolve(primary,2500).globalConfidence).toBeNull();
    c.observe(sample(2600,{frameAgeMs:500})); expect(c.resolve(primary,2650).globalConfidence).toBeNull();
    c.observe(sample(2800,{confidence:.4,detected:false})); expect(c.resolve(primary,2850).reacquisitionConfirmed).toBe(false);
    c.reset(); expect(c.resolve(primary,2900).globalConfidence).toBeNull();
  });
  it('duplicate callbacks cannot count as independent reacquisition confirmations', () => {
    const c=new HybridCoordinator({enabled:true,poseAssist:false,reacquisitionAssist:true});
    c.observe(sample());c.observe(sample()); expect(c.resolve(primary,1100).reacquisitionConfirmed).toBe(false);
  });
  it('rejects unproven pose assistance even when the feature flag is requested', () => {
    const c=new HybridCoordinator({enabled:true,poseAssist:true,reacquisitionAssist:true}); c.observe(sample());
    const out=c.resolve(primary,1100); expect(out.poseAssistApplied).toBe(false); expect(out.pose).toBe(primary.pose);
  });
});
