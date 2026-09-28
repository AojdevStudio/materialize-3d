import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, Grid, Center, Bounds, useBounds } from '@react-three/drei'
import { invoke } from '@tauri-apps/api/core'
import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { useWorkspaceStore } from '../stores/workspace'
import styles from './ModelViewer.module.css'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModelDimensions {
  x: number
  y: number
  z: number
}

interface UseModelLoaderResult {
  scene: THREE.Object3D | null
  dimensions: ModelDimensions | null
  loading: boolean
  error: string | null
}

// ─── useModelLoader hook ──────────────────────────────────────────────────────

export function useModelLoader(path: string | null): UseModelLoaderResult {
  const [scene, setScene] = useState<THREE.Object3D | null>(null)
  const [dimensions, setDimensions] = useState<ModelDimensions | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sceneRef = useRef<THREE.Object3D | null>(null)

  useEffect(() => {
    if (!path) {
      setScene(null)
      setDimensions(null)
      setLoading(false)
      setError(null)
      return
    }

    let cancelled = false

    async function loadModel() {
      setLoading(true)
      setError(null)

      try {
        // Read file bytes via Tauri IPC
        const bytes = await invoke<number[]>('read_model_file', { path })
        if (cancelled) return

        const uint8 = new Uint8Array(bytes)
        const buffer = uint8.buffer

        // Detect file type from extension
        const ext = path!.split('.').pop()?.toLowerCase() ?? ''
        let object: THREE.Object3D

        if (ext === 'stl') {
          const loader = new STLLoader()
          const geometry = loader.parse(buffer)
          const material = new THREE.MeshStandardMaterial({
            color: 0xe8682a, // --accent-orange
            roughness: 0.4,
            metalness: 0.1,
          })
          object = new THREE.Mesh(geometry, material)
        } else if (ext === '3mf') {
          const loader = new ThreeMFLoader()
          const group = loader.parse(buffer)
          // z-up → y-up conversion
          group.rotation.x = -Math.PI / 2
          group.updateMatrixWorld(true)

          // Apply accent-orange material to all meshes
          group.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              child.material = new THREE.MeshStandardMaterial({
                color: 0xe8682a,
                roughness: 0.4,
                metalness: 0.1,
              })
            }
          })
          object = group
        } else {
          throw new Error(`Unsupported file format: .${ext}`)
        }

        if (cancelled) {
          disposeObject(object)
          return
        }

        // Compute bounding box
        const box = new THREE.Box3().setFromObject(object)
        if (!isFinite(box.min.x) || !isFinite(box.max.x)) {
          throw new Error('Model has invalid (non-finite) bounds')
        }

        const size = new THREE.Vector3()
        box.getSize(size)

        console.debug('Model loaded:', path, {
          vertices: countVertices(object),
          dimensions: { x: size.x.toFixed(1), y: size.y.toFixed(1), z: size.z.toFixed(1) },
        })

        sceneRef.current = object
        setScene(object)
        setDimensions({ x: size.x, y: size.y, z: size.z })
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        console.error('Model load error:', path, message)
        setError(message)
        setScene(null)
        setDimensions(null)
        setLoading(false)
      }
    }

    loadModel()

    return () => {
      cancelled = true
      if (sceneRef.current) {
        disposeObject(sceneRef.current)
        sceneRef.current = null
      }
    }
  }, [path])

  return { scene, dimensions, loading, error }
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry?.dispose()
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => m.dispose())
      } else {
        child.material?.dispose()
      }
    }
  })
}

function countVertices(obj: THREE.Object3D): number {
  let count = 0
  obj.traverse((child) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      const pos = child.geometry.getAttribute('position')
      if (pos) count += pos.count
    }
  })
  return count
}

// ─── Build Plate Boundary ─────────────────────────────────────────────────────

function BuildPlateBoundary() {
  const points = useMemo(() => {
    const hw = 256 / 2 // half-width
    const hd = 256 / 2 // half-depth
    return [
      new THREE.Vector3(-hw, 0, -hd),
      new THREE.Vector3(hw, 0, -hd),
      new THREE.Vector3(hw, 0, hd),
      new THREE.Vector3(-hw, 0, hd),
      new THREE.Vector3(-hw, 0, -hd), // close the loop
    ]
  }, [])

  const geometry = useMemo(() => {
    return new THREE.BufferGeometry().setFromPoints(points)
  }, [points])

  return (
    <lineLoop geometry={geometry}>
      <lineBasicMaterial color="#2a2a30" linewidth={1} />
    </lineLoop>
  )
}

// ─── Camera Controls (inner scene component for useThree access) ──────────────

const INITIAL_CAMERA_POSITION = new THREE.Vector3(300, 300, 300)
const INITIAL_TARGET = new THREE.Vector3(0, 0, 0)

interface CameraControllerProps {
  controlsRef: React.MutableRefObject<any>
  onResetRef: React.MutableRefObject<(() => void) | null>
}

function CameraController({ controlsRef, onResetRef }: CameraControllerProps) {
  const { camera } = useThree()

  // Expose reset function to parent
  useEffect(() => {
    onResetRef.current = () => {
      camera.position.copy(INITIAL_CAMERA_POSITION)
      if (controlsRef.current) {
        controlsRef.current.target.copy(INITIAL_TARGET)
        controlsRef.current.update()
      }
      console.debug('viewport:action', 'reset')
    }
    return () => {
      onResetRef.current = null
    }
  }, [camera, controlsRef, onResetRef])

  return null
}

// ─── Model Scene with Bounds ──────────────────────────────────────────────────

interface ModelSceneProps {
  object: THREE.Object3D
  fitRef: React.MutableRefObject<(() => void) | null>
}

function ModelScene({ object, fitRef }: ModelSceneProps) {
  return (
    <Bounds fit clip observe margin={1.2}>
      <FitController fitRef={fitRef} />
      <Center top>
        <primitive object={object} />
      </Center>
    </Bounds>
  )
}

function FitController({ fitRef }: { fitRef: React.MutableRefObject<(() => void) | null> }) {
  const bounds = useBounds()

  useEffect(() => {
    fitRef.current = () => {
      bounds.refresh().clip().fit()
      console.debug('viewport:action', 'fit')
    }
    return () => {
      fitRef.current = null
    }
  }, [bounds, fitRef])

  return null
}

// ─── ModelViewer Component ────────────────────────────────────────────────────

export interface ModelViewerProps {
  modelPath?: string | null
  onDimensionsChange?: (dimensions: ModelDimensions | null) => void
  onError?: (error: string | null) => void
  onLoadingChange?: (loading: boolean) => void
}

export function ModelViewer({
  modelPath,
  onDimensionsChange,
  onError,
  onLoadingChange,
}: ModelViewerProps) {
  // Get model name from workspace store
  const activeModel = useWorkspaceStore((state) => state.activeModel)
  const effectivePath = modelPath !== undefined ? modelPath : (activeModel?.path ?? null)
  const modelName = activeModel?.name ?? null

  const { scene, dimensions, loading, error } = useModelLoader(effectivePath)

  // Refs for camera control
  const controlsRef = useRef<any>(null)
  const resetRef = useRef<(() => void) | null>(null)
  const fitRef = useRef<(() => void) | null>(null)

  // Notify parent of state changes
  useEffect(() => {
    onDimensionsChange?.(dimensions)
  }, [dimensions, onDimensionsChange])

  useEffect(() => {
    onError?.(error)
  }, [error, onError])

  useEffect(() => {
    onLoadingChange?.(loading)
  }, [loading, onLoadingChange])

  // ─── Viewport button handlers ────────────────────────────────────────────

  const handleZoomIn = useCallback(() => {
    if (!controlsRef.current) return
    const controls = controlsRef.current
    const camera = controls.object as THREE.PerspectiveCamera
    const direction = new THREE.Vector3()
    direction.subVectors(controls.target, camera.position)
    const distance = direction.length()
    direction.normalize()
    // Move camera 20% closer to target
    camera.position.addScaledVector(direction, distance * 0.2)
    controls.update()
    console.debug('viewport:action', 'zoom-in')
  }, [])

  const handleZoomOut = useCallback(() => {
    if (!controlsRef.current) return
    const controls = controlsRef.current
    const camera = controls.object as THREE.PerspectiveCamera
    const direction = new THREE.Vector3()
    direction.subVectors(camera.position, controls.target)
    direction.normalize()
    const distance = camera.position.distanceTo(controls.target)
    // Move camera 20% farther from target
    camera.position.addScaledVector(direction, distance * 0.2)
    controls.update()
    console.debug('viewport:action', 'zoom-out')
  }, [])

  const handleResetView = useCallback(() => {
    resetRef.current?.()
  }, [])

  const handleFitToView = useCallback(() => {
    fitRef.current?.()
  }, [])

  // ─── Format dimensions ───────────────────────────────────────────────────

  const dimensionText = dimensions
    ? `${dimensions.x.toFixed(1)} × ${dimensions.y.toFixed(1)} × ${dimensions.z.toFixed(1)} mm`
    : null

  return (
    <div className={styles.viewerContainer} data-testid="model-viewer-container">
      <Canvas
        camera={{
          fov: 50,
          position: [300, 300, 300],
          near: 0.1,
          far: 5000,
        }}
        style={{ background: '#0a0a0c' }}
        gl={{ antialias: true }}
      >
        {/* Lighting */}
        <ambientLight intensity={0.4} />
        <directionalLight position={[200, 400, 200]} intensity={0.8} />

        {/* Build plate grid: P2S 256×256mm */}
        <Grid
          args={[256, 256]}
          cellSize={10}
          sectionSize={50}
          cellColor="#1e1e23"
          sectionColor="#2a2a30"
          fadeDistance={600}
          position={[0, -0.01, 0]}
          infiniteGrid={false}
        />

        {/* Build plate boundary outline */}
        <BuildPlateBoundary />

        {/* Model (if loaded) */}
        {scene && <ModelScene object={scene} fitRef={fitRef} />}

        {/* Controls */}
        <OrbitControls
          ref={controlsRef}
          enableDamping
          dampingFactor={0.1}
          minDistance={50}
          maxDistance={1000}
        />

        {/* Camera controller for reset functionality */}
        <CameraController controlsRef={controlsRef} onResetRef={resetRef} />
      </Canvas>

      {/* ─── Info Overlay (top-left) ─────────────────────────────────────── */}
      <div className={styles.viewportInfo} data-testid="viewport-info">
        {modelName && (
          <div className={styles.infoChip} data-testid="chip-model">
            <span className={styles.chipLabel}>Model</span>
            <span className={styles.chipValue}>{modelName}</span>
          </div>
        )}
        {dimensionText && (
          <div className={styles.infoChip} data-testid="chip-size">
            <span className={styles.chipLabel}>Size</span>
            <span className={styles.chipValue}>{dimensionText}</span>
          </div>
        )}
      </div>

      {/* ─── Viewport Control Buttons (bottom-right) ─────────────────────── */}
      <div className={styles.viewportOverlay} data-testid="viewport-overlay">
        <button
          className={styles.viewportBtn}
          title="Zoom In"
          onClick={handleZoomIn}
          type="button"
        >
          +
        </button>
        <button
          className={styles.viewportBtn}
          title="Zoom Out"
          onClick={handleZoomOut}
          type="button"
        >
          −
        </button>
        <button
          className={styles.viewportBtn}
          title="Reset View"
          onClick={handleResetView}
          type="button"
        >
          ⟲
        </button>
        <button
          className={styles.viewportBtn}
          title="Fit to View"
          onClick={handleFitToView}
          type="button"
        >
          ⊞
        </button>
      </div>
    </div>
  )
}

export default ModelViewer
