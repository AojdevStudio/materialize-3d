import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import useTauriEvent from '../hooks/useTauriEvent'

export type ConnectionType = 'mqtt' | 'cloud' | null

export type ConnectionState =
  | 'disconnected'
  | 'discovering'
  | 'connected_mqtt'
  | 'connected_cloud'
  | 'reconnecting'
  | 'offline'

export interface AmsTrayState {
  trayId: number | null
  trayType: string | null
  trayColor: string | null
}

export interface AmsUnitState {
  id: number | null
  trays: AmsTrayState[]
}

export type CameraStatus = 'unavailable' | 'probing' | 'available' | 'error'

export interface CameraState {
  status: CameraStatus
  url: string | null
  diagnostic: string | null
}

export interface PrinterSnapshot {
  isConnected: boolean
  connectionType: ConnectionType
  connectionState: ConnectionState
  name: string | null
  nozzleTemp: number | null
  nozzleTargetTemp: number | null
  bedTemp: number | null
  bedTargetTemp: number | null
  chamberTemp: number | null
  gcodeState: string | null
  printProgress: number | null
  remainingTime: number | null
  layerNum: number | null
  totalLayerNum: number | null
  subtaskName: string | null
  wifiSignal: string | null
  amsState: AmsUnitState[]
  lastError: string | null
  cameraState: CameraState
  printerIp: string | null
}

interface PrinterState extends PrinterSnapshot {
  applySnapshot: (snapshot: Partial<PrinterSnapshot>) => void
}

export const PRINTER_DEFAULT_STATE: PrinterSnapshot = {
  isConnected: false,
  connectionType: null,
  connectionState: 'disconnected',
  name: null,
  nozzleTemp: null,
  nozzleTargetTemp: null,
  bedTemp: null,
  bedTargetTemp: null,
  chamberTemp: null,
  gcodeState: null,
  printProgress: null,
  remainingTime: null,
  layerNum: null,
  totalLayerNum: null,
  subtaskName: null,
  wifiSignal: null,
  amsState: [],
  lastError: null,
  cameraState: { status: 'unavailable', url: null, diagnostic: null },
  printerIp: null,
}

export const usePrinterStore = create<PrinterState>()(
  subscribeWithSelector((set) => ({
    ...PRINTER_DEFAULT_STATE,
    applySnapshot: (snapshot) => set((state) => ({ ...state, ...snapshot })),
  })),
)

export function applyPrinterSnapshot(snapshot: Partial<PrinterSnapshot>) {
  usePrinterStore.getState().applySnapshot(snapshot)
}

export function usePrinterEvents() {
  useTauriEvent<PrinterSnapshot>('printer:changed', ({ payload }) => {
    console.debug('event received:', 'printer:changed', payload)
    applyPrinterSnapshot(payload)
  })
}
