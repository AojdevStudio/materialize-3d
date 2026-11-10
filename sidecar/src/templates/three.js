// The parts of three.js the guide template uses, as one global. guide.ts bundles this into the template.
import { Scene, PerspectiveCamera, WebGLRenderer, Group, Mesh, MeshStandardMaterial, BufferGeometry, BufferAttribute, CylinderGeometry, HemisphereLight, DirectionalLight, Color, Vector3, EdgesGeometry, LineSegments, LineBasicMaterial } from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

window.T = { Scene, PerspectiveCamera, WebGLRenderer, Group, Mesh, MeshStandardMaterial, BufferGeometry, BufferAttribute, CylinderGeometry, HemisphereLight, DirectionalLight, Color, Vector3, EdgesGeometry, LineSegments, LineBasicMaterial, OrbitControls }
