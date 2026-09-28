import { useEffect, useRef } from 'react'
import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event'

export function useTauriEvent<T>(eventName: string, callback: (event: Event<T>) => void) {
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    let disposed = false
    let unlisten: UnlistenFn | null = null

    const subscribe = async () => {
      try {
        const teardown = await listen<T>(eventName, (event) => callbackRef.current(event))

        if (disposed) {
          teardown()
          return
        }

        unlisten = teardown
      } catch (error) {
        console.error(`failed to subscribe to ${eventName}`, error)
      }
    }

    void subscribe()

    return () => {
      disposed = true

      if (unlisten) {
        unlisten()
      }
    }
  }, [eventName])
}

export default useTauriEvent
