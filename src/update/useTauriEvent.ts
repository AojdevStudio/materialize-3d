import { useEffect, useRef } from 'react'
import { listenTo, type Events } from '../studio/api'

export function useTauriEvent<E extends keyof Events>(event: E, handler: (payload: Events[E]) => void) {
  const handlerRef = useRef(handler)

  useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  useEffect(() => listenTo(event, (payload) => handlerRef.current(payload)).stop, [event])
}
