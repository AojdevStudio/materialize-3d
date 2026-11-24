import { useEffect, useState } from 'react'
import type { MobilePairing, PairedDevice } from '../../sidecar/src/protocol'
import { onSidecarEvent, sidecar } from './api'

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const day = (ms: number) => new Date(ms).toLocaleDateString([], { dateStyle: 'medium' })

/** Settings' phone and tablet section: a pairing code as a QR image, and the paired devices, each with Forget. */
export default function Phones({ onError }: { onError: (message: string) => void }) {
  const [pairing, setPairing] = useState<MobilePairing | null>(null)
  const [devices, setDevices] = useState<PairedDevice[] | null>(null)
  /** The device that redeemed the code on screen, which is spent now. */
  const [paired, setPaired] = useState<PairedDevice | null>(null)

  // A new code, and the devices again, since one may have paired with the last code.
  const refresh = (current = () => true) => {
    setPairing(null)
    setPaired(null)
    const failed = (err: unknown) => current() && onError(String(err))
    void sidecar('mobile.pair', {}).then((value) => current() && setPairing(value), failed)
    void sidecar('mobile.devices', {}).then((value) => current() && setDevices(value), failed)
  }

  useEffect(() => {
    let current = true
    refresh(() => current)
    return () => {
      current = false
    }
  }, [])

  // A phone that scans the code shows here at once, and its spent code goes away.
  useEffect(
    () =>
      onSidecarEvent((event) => {
        if (event.type !== 'paired') return
        setDevices(event.devices)
        setPaired(event.device)
      }).stop,
    [],
  )

  const forget = (device: string) => void sidecar('mobile.forget', { device }).then(setDevices, (err: unknown) => onError(String(err)))

  return (
    <>
      <section className="setup-group" aria-label="Pair a device">
        <h2>Pair a device</h2>
        {paired !== null && devices?.some((device) => device.id === paired.id) === true && (
          <p className="setup-detail">{paired.name} is paired. Show a new code to pair another device.</p>
        )}
        {paired === null && pairing === null && <p className="setup-detail">Checking…</p>}
        {paired === null && pairing?.kind === 'ready' && (
          <div className="settings-pair">
            <img alt="Pairing code" src={`data:image/svg+xml,${encodeURIComponent(pairing.svg)}`} />
            <p className="setup-detail">Scan it in the Materialize 3D app on your iPhone or iPad. It works once, until {time(pairing.expiresMs)}.</p>
          </div>
        )}
        {pairing?.kind === 'setup' && (
          <>
            <p className="setup-detail">Let Tailscale reach this app once. Run this in Terminal, then check again.</p>
            <div className="settings-folder">
              <code>{pairing.command}</code>
            </div>
          </>
        )}
        {pairing?.kind === 'off' && <p className="setup-detail">{pairing.detail}</p>}
        {(pairing !== null || paired !== null) && (
          <button type="button" className="settings-pair-again" onClick={() => refresh()}>
            {paired !== null || pairing?.kind === 'ready' ? 'New code' : 'Check again'}
          </button>
        )}
      </section>
      <section className="setup-group" aria-label="Paired devices">
        <h2>Paired devices</h2>
        {devices?.length === 0 && <p className="setup-detail">No phone or tablet is paired.</p>}
        <ul>
          {devices?.map((device) => (
            <li key={device.id} className="setup-row" data-testid="settings-device">
              <span />
              <span className="setup-what">
                <span className="setup-name">{device.name}</span>
                <span className="setup-detail">Paired {day(device.pairedMs)}</span>
              </span>
              <span className="setup-act">
                <button type="button" onClick={() => forget(device.id)}>
                  Forget
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}
