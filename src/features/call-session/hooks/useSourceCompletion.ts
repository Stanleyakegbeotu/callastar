import { useCallback, useEffect, useRef, useState } from "react"
import { productionDiagnostic } from "@/lib/productionDiagnostics"

/** Only the selected host media's natural ended event starts this transition. */
export function useSourceCompletion(sessionId: string, finish: () => void, persist?: () => Promise<void>, onFailure?: () => void) {
  const [ending, setEnding] = useState(false)
  const [completed, setCompleted] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callback = useRef(finish)
  callback.current = finish
  const persistence = useRef(persist)
  persistence.current = persist
  const failure = useRef(onFailure)
  failure.current = onFailure
  const pending = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    setEnding(false)
    setCompleted(false)
    pending.current = false
    generation.current++
    return () => {
      generation.current++
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [sessionId])
  const onEnded = useCallback(() => {
    if (pending.current) return
    pending.current = true
    const current = generation.current
    productionDiagnostic("SOURCE_VIDEO_ENDED")
    setEnding(true)
    // Keep rendered media mounted through this brief transition. Evidence can
    // finish copying its frame before tracks and the source are destroyed.
    void (async () => {
      try {
        await persistence.current?.()
        if (generation.current !== current) return
        timer.current = setTimeout(() => {
          callback.current()
          setEnding(false)
          setCompleted(true)
          productionDiagnostic("CALL_ENDED", { kind: "source_video_ended" })
        }, 1200)
      } catch {
        if (generation.current !== current) return
        setEnding(false)
        failure.current?.()
      }
    })()
  }, [])
  return { ending, completed, onEnded }
}
