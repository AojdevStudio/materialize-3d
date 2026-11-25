// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ModelChoice, ModelOption } from '../../sidecar/src/protocol'
import ModelPicker from './ModelPicker'

const opus: ModelOption = { provider: 'anthropic', modelId: 'claude-opus-5-5', name: 'Opus 5.5', description: '' }
const sol: ModelOption = { provider: 'openai-codex', modelId: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', description: '' }

afterEach(cleanup)

const onPick = vi.fn<(model: ModelChoice) => void>()

function show(chosen: ModelChoice | null = { provider: opus.provider, modelId: opus.modelId }, models = [opus, sol]) {
  onPick.mockClear()
  render(<ModelPicker role="Lead" models={models} chosen={chosen} onPick={onPick} />)
  return screen.getByTestId('model-picker')
}

const menu = () => screen.queryByRole('menu', { name: 'Lead models' })

describe('ModelPicker', () => {
  it('names each button by its role and model, so the same model in both roles reads apart', () => {
    const same = { provider: sol.provider, modelId: sol.modelId }
    render(
      <>
        <ModelPicker role="Lead" models={[opus, sol]} chosen={same} onPick={onPick} />
        <ModelPicker role="Helper" models={[opus, sol]} chosen={same} onPick={() => {}} />
      </>,
    )
    expect(screen.getByRole('button', { name: 'Lead: GPT 6.1 Sol' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Helper: GPT 6.1 Sol' })).toBeTruthy()
  })

  it('opens on its button with the chosen model checked, and closes on a second click', () => {
    const button = show()
    expect(button.textContent).toBe('Opus 5.5')
    expect(menu()).toBeNull()
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('menuitemradio').map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
      ['Opus 5.5', 'true'],
      ['GPT 6.1 Sol', 'false'],
    ])
    fireEvent.click(button)
    expect(menu()).toBeNull()
  })

  it('closes on Escape and on a click outside, and stays open on a click inside', () => {
    const button = show()
    fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(menu()).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(menu()).toBeNull()

    fireEvent.click(button)
    fireEvent.mouseDown(screen.getByRole('menuitemradio', { name: 'GPT 6.1 Sol' }))
    expect(menu()).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(menu()).toBeNull()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('picks the chosen model again, which lets a chat choose a lead it found retired, and picks another', () => {
    const button = show()
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Opus 5.5' }))
    expect(menu()).toBeNull()
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ provider: 'anthropic', modelId: 'claude-opus-5-5' })

    onPick.mockClear()
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'GPT 6.1 Sol' }))
    expect(menu()).toBeNull()
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ provider: 'openai-codex', modelId: 'gpt-6.1-sol' })
  })

  it('stays off until a model is chosen and the list has one, and names a model off the list by its id', () => {
    expect(show(null).hasAttribute('disabled')).toBe(true)
    cleanup()
    expect(show(undefined, []).hasAttribute('disabled')).toBe(true)
    cleanup()
    expect(show({ provider: 'anthropic', modelId: 'claude-retired-1' }).textContent).toBe('claude-retired-1')
  })

  it('as the helper, offers No helper on top, reads None while it is chosen, and picks it', () => {
    const onHelper = vi.fn<(model: ModelChoice | null) => void>()
    const { rerender } = render(<ModelPicker role="Helper" models={[opus, sol]} chosen={null} onPick={onHelper} />)
    const button = screen.getByTestId('helper-picker')
    expect(button.textContent).toBe('None')
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    const items = () => within(screen.getByRole('menu', { name: 'Helper models' })).getAllByRole('menuitemradio')
    expect(items().map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
      ['No helper', 'true'],
      ['Opus 5.5', 'false'],
      ['GPT 6.1 Sol', 'false'],
    ])
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Opus 5.5' }))
    expect(onHelper).toHaveBeenCalledExactlyOnceWith({ provider: 'anthropic', modelId: 'claude-opus-5-5' })

    rerender(<ModelPicker role="Helper" models={[opus, sol]} chosen={{ provider: opus.provider, modelId: opus.modelId }} onPick={onHelper} />)
    expect(button.textContent).toBe('Opus 5.5')
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'No helper' }))
    expect(onHelper).toHaveBeenLastCalledWith(null)
  })
})
