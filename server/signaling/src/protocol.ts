/**
 * The wire protocol, re-exported from the browser source tree.
 *
 * One definition, imported by both ends. A second copy would drift, and a
 * protocol that disagrees with itself produces bugs that only appear between two
 * real devices — which is exactly where they are hardest to find.
 *
 * `src/services/signaling/protocol.ts` is dependency-free for this reason: no
 * `@/` alias, no DOM types, nothing that only exists inside a bundle.
 */
export * from "../../../src/services/signaling/protocol.ts";
