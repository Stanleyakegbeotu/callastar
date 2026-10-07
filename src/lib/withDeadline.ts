export async function withDeadline<T>(work: PromiseLike<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("The request took too long. Please retry.")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
