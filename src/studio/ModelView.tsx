import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'

async function loadModel(url: string, ext: string): Promise<THREE.Object3D> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(await response.text())
  const data = await response.arrayBuffer()
  const material = new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.65, metalness: 0.05 })
  if (ext === 'stl') {
    const geometry = new STLLoader().parse(data)
    geometry.computeVertexNormals()
    return zUp(new THREE.Mesh(geometry, material))
  }
  if (ext === '3mf') {
    const group = new ThreeMFLoader().parse(data)
    let meshes = 0
    group.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        meshes += 1
        node.material = material
      }
    })
    if (meshes === 0) throw new Error('This 3MF holds no shapes the viewer can read.')
    return zUp(group)
  }
  const gltf = await new GLTFLoader().parseAsync(data, '')
  return gltf.scene
}

/** STL and 3MF files are Z-up like the printer. three.js is Y-up. */
function zUp(object: THREE.Object3D): THREE.Object3D {
  object.rotation.x = -Math.PI / 2
  return object
}

/**
 * A simple orbit viewer. It draws only when the view changes, so an idle
 * preview costs nothing.
 */
export default function ModelView({ url, ext }: { url: string; ext: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    setError(null)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    element.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf6f6f4)
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b4ac, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    scene.add(sun)
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000)
    const controls = new OrbitControls(camera, renderer.domElement)
    const render = () => {
      sun.position.copy(camera.position)
      renderer.render(scene, camera)
    }
    controls.addEventListener('change', render)
    const resize = () => {
      const { clientWidth: width, clientHeight: height } = element
      if (width === 0 || height === 0) return
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      render()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)

    let disposed = false
    loadModel(url, ext)
      .then((object) => {
        if (disposed) return
        const box = new THREE.Box3().setFromObject(object)
        const center = box.getCenter(new THREE.Vector3())
        const size = box.getSize(new THREE.Vector3())
        object.position.sub(new THREE.Vector3(center.x, box.min.y, center.z))
        scene.add(object)
        const radius = Math.max(size.x, size.y, size.z)
        const grid = new THREE.GridHelper(Math.ceil((radius * 2.5) / 10) * 10, 20, 0xc9c6bf, 0xe2e0db)
        scene.add(grid)
        controls.target.set(0, size.y / 2, 0)
        camera.position.set(radius * 1.2, radius * 0.9 + size.y / 2, radius * 1.6)
        camera.near = radius / 100
        camera.far = radius * 100
        camera.updateProjectionMatrix()
        controls.update()
        resize()
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      disposed = true
      observer.disconnect()
      controls.dispose()
      scene.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose()
          const materials = Array.isArray(node.material) ? node.material : [node.material]
          materials.forEach((m: THREE.Material) => m.dispose())
        }
      })
      renderer.dispose()
      element.removeChild(renderer.domElement)
    }
  }, [url, ext])

  return (
    <div className="model-view" ref={host} data-testid="model-view">
      {error && <p className="preview-note">Could not show this model. {error}</p>}
    </div>
  )
}
