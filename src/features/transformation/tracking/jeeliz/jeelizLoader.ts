import type { JeelizApi } from './jeelizTypes';

/** Direct dist import avoids bundling all four JSON models through index.js. */
export async function loadJeeliz(): Promise<JeelizApi> {
  const { default: api } = await import('facefilter/dist/jeelizFaceFilter.moduleES6.js');
  if (typeof api.create_new !== 'function') throw new Error('Official Jeeliz module did not expose create_new.');
  return api.create_new();
}
