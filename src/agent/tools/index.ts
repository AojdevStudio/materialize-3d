import type { AgentTool } from '@mariozechner/pi-agent-core'
import { getPrinterStatusTool } from './get-printer-status'
import { searchMakerworldTool } from './search-makerworld'
import { sliceModelTool } from './slice-model'
import { showModelTool } from './show-model'
import { navigateToTool } from './navigate-to'
import { downloadModelTool } from './download-model'
import { startPrintTool } from './start-print'
import { createScadTool } from './create-scad'
import { modifyScadTool } from './modify-scad'
import { setScadParametersTool } from './set-scad-parameters'
import { renderScadPreviewTool } from './render-scad-preview'

export { getPrinterStatusTool } from './get-printer-status'
export { searchMakerworldTool } from './search-makerworld'
export { sliceModelTool } from './slice-model'
export { showModelTool } from './show-model'
export { navigateToTool } from './navigate-to'
export { downloadModelTool } from './download-model'
export { startPrintTool } from './start-print'
export { createScadTool } from './create-scad'
export { modifyScadTool } from './modify-scad'
export { setScadParametersTool } from './set-scad-parameters'
export { renderScadPreviewTool } from './render-scad-preview'

/**
 * All agent tools as an array for registration with the Agent instance.
 * AgentTool<any> is the correct generic for heterogeneous tool arrays per pi-agent-core conventions.
 */
export const agentTools: AgentTool<any>[] = [
  getPrinterStatusTool,
  searchMakerworldTool,
  sliceModelTool,
  showModelTool,
  navigateToTool,
  downloadModelTool,
  startPrintTool,
  createScadTool,
  modifyScadTool,
  setScadParametersTool,
  renderScadPreviewTool,
]
