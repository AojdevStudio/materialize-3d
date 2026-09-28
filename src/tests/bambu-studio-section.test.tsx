// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
const pickFileMock = vi.fn()
vi.mock('../lib/fileDialog', () => ({ pickFile: (...args: unknown[]) => pickFileMock(...args) }))

import { BambuStudioSection, type BambuStudioStatus } from '../components/BambuStudioSection'

const DOWNLOAD_URL = 'https://github.com/bambulab/BambuStudio/releases/tag/v02.08.02.61'
const common = { validatedVersions: ['02.08.02.61'], downloadUrl: DOWNLOAD_URL }
const CHOSEN = '/Applications/BambuStudio-02.08.02.61/BambuStudio.app'

const found: BambuStudioStatus = {
  ...common,
  state: 'found',
  path: `${CHOSEN}/Contents/MacOS/BambuStudio`,
  version: '02.08.02.61',
  chosenPath: CHOSEN,
}
const unvalidated: BambuStudioStatus = {
  ...common,
  state: 'unvalidated',
  builds: [{ path: '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio', version: '02.07.01.62' }],
  chosenPath: null,
}
const notFound: BambuStudioStatus = {
  ...common,
  state: 'not_found',
  detail: 'no Bambu Studio installation found; searched /Applications/BambuStudio.app',
  chosenPath: null,
}

function serve(status: BambuStudioStatus) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'bambu_studio_status') return status
    throw new Error(`unexpected ${cmd}`)
  })
}

describe('BambuStudioSection', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    pickFileMock.mockReset()
  })
  afterEach(cleanup)

  it('shows the version and path of a validated Bambu Studio, without setup steps', async () => {
    serve(found)
    render(<BambuStudioSection active />)
    expect((await screen.findByTestId('bambu-studio-found')).textContent).toContain('02.08.02.61')
    expect(screen.getByTestId('bambu-studio-path').textContent).toBe(`${CHOSEN}/Contents/MacOS/BambuStudio`)
    expect(screen.queryByTestId('bambu-studio-steps')).toBeNull()
    expect(screen.getByTestId('bambu-studio-clear')).toBeTruthy()
  })

  it('names an unvalidated version and explains how to install the validated one beside it', async () => {
    serve(unvalidated)
    render(<BambuStudioSection active />)
    const problem = await screen.findByTestId('bambu-studio-problem')
    expect(problem.textContent).toContain('02.07.01.62')
    expect(problem.textContent).toContain('/Applications/BambuStudio.app/Contents/MacOS/BambuStudio')
    const steps = screen.getByTestId('bambu-studio-steps')
    expect(steps.textContent).toContain('BambuStudio-02.08.02.61')
    expect(screen.getByRole('link', { name: /02\.08\.02\.61/ }).getAttribute('href')).toBe(DOWNLOAD_URL)
    expect(screen.queryByTestId('bambu-studio-clear')).toBeNull()
  })

  it('shows what was searched and the setup steps when Bambu Studio is not found', async () => {
    serve(notFound)
    render(<BambuStudioSection active />)
    const problem = await screen.findByTestId('bambu-studio-problem')
    expect(problem.textContent).toContain('searched /Applications/BambuStudio.app')
    expect(screen.getByTestId('bambu-studio-steps')).toBeTruthy()
    expect(screen.getByRole('link', { name: /02\.08\.02\.61/ }).getAttribute('href')).toBe(DOWNLOAD_URL)
  })

  it('chooses an app through the native open dialog and shows the new status', async () => {
    serve(notFound)
    pickFileMock.mockResolvedValue(CHOSEN)
    render(<BambuStudioSection active />)
    await screen.findByTestId('bambu-studio-steps')
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'choose_bambu_studio') return found
      throw new Error(`unexpected ${cmd}`)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Choose Bambu Studio…' }))
    await screen.findByTestId('bambu-studio-found')
    expect(pickFileMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('choose_bambu_studio', { path: CHOSEN })
    expect(screen.queryByTestId('bambu-studio-steps')).toBeNull()
  })

  it('shows why a chosen app was refused and keeps the setup steps', async () => {
    serve(notFound)
    pickFileMock.mockResolvedValue('/Applications/BambuStudio.app')
    render(<BambuStudioSection active />)
    await screen.findByTestId('bambu-studio-steps')
    invokeMock.mockRejectedValue('the chosen Bambu Studio /Applications/BambuStudio.app (02.07.01.62) is not a validated version')
    fireEvent.click(screen.getByRole('button', { name: 'Choose Bambu Studio…' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not a validated version'))
    expect(screen.getByTestId('bambu-studio-steps')).toBeTruthy()
  })
})
