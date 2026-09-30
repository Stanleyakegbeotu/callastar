import { expose } from "comlink";

/** A disposable protocol check. No media or model data crosses this worker. */
expose({ ping: () => "ready" as const });
