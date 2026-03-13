import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// --- State ---
let loadedFile = null;
let parsedData = null; // { bodies: [{ vertices, indices, normals, color, material }], totalVerts, totalFaces, materials, hierarchy }
let scene, camera, renderer, controls;
let meshGroup = null;
let wireframeOn = false;
let initialCamPos = null;
let initialTarget = null;
let meshHierarchy = null; // { nodes tree }
let animFrameId = null;
let resizeObserver = null;
let objectUrls = [];

// --- DOM ---
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileName = document.getElementById('fileName');
const convertBtn = document.getElementById('convertBtn');
const progress = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const spinner = document.getElementById('spinner');
const results = document.getElementById('results');
const errorBox = document.getElementById('errorBox');
const previewPanel = document.getElementById('previewPanel');
const previewToolbar = document.getElementById('previewToolbar');
const meshInfo = document.getElementById('meshInfo');
const btnWireframe = document.getElementById('btnWireframe');
const btnResetCam = document.getElementById('btnResetCam');

// --- Format buttons ---
const formatBtns = document.querySelectorAll('.format-btn');
formatBtns.forEach(btn => {
  btn.addEventListener('click', () => btn.classList.toggle('active'));
});

// --- Drop zone ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

// --- Default body colors (pastel palette for visual distinction) ---
const BODY_COLORS = [
  0x4fc3f7, 0x81c784, 0xffb74d, 0xba68c8, 0xe57373,
  0x4dd0e1, 0xaed581, 0xff8a65, 0x9575cd, 0xf06292,
  0x4db6ac, 0xdce775, 0xffd54f, 0x7986cb, 0xa1887f,
];

async function handleFile(file) {
  const ext = file.name.toLowerCase();
  const cadExts = ['.stp', '.step', '.iges', '.igs'];
  const modelExts = ['.skp', '.fbx', '.obj', '.3ds', '.dae', '.ply', '.blend', '.gltf', '.glb', '.stl', '.dxf', '.usdz'];
  const isCad = cadExts.some(e => ext.endsWith(e));
  const isModel = modelExts.some(e => ext.endsWith(e));
  
  if (!isCad && !isModel) {
    showError('Onbekend formaat. Ondersteund: STEP/IGES (CAD), SKP/FBX/OBJ/3DS/DAE/PLY/BLEND/GLTF/GLB/STL/DXF/USDZ (3D modellen).');
    return;
  }
  
  hideError();
  loadedFile = file;
  fileName.textContent = `${file.name} (${formatSize(file.size)})`;
  convertBtn.disabled = false;
  
  try {
    const buffer = await file.arrayBuffer();
    
    if (isCad) {
      await handleCADFile(buffer, ext);
    } else {
      await handleModelFile(buffer, file.name);
    }
    
    showProgress('3D preview laden...', 80);
    setupPreview();
    updateMeshInfo();
    showProgress('Klaar!', 100);
    setTimeout(() => { progress.classList.remove('active'); }, 500);
  } catch (err) {
    showError(`Fout bij laden: ${err.message}`);
    progress.classList.remove('active');
  }
}

async function handleCADFile(buffer, ext) {
  showProgress('STEP/IGES bestand laden...', 10);
  showProgress('OpenCascade WASM initialiseren...', 30);
  const occt = await occtimportjs();
  showProgress('Geometrie parsen...', 50);
  
  let result;
  if (ext.endsWith('.iges') || ext.endsWith('.igs')) {
    result = occt.ReadIgesFile(new Uint8Array(buffer), null);
  } else {
    result = occt.ReadStepFile(new Uint8Array(buffer), null);
  }
  
  if (!result.success) throw new Error('Kan CAD bestand niet parsen');
  
  const bodies = [];
  let totalVerts = 0;
  let totalFaces = 0;
  
  for (let mi = 0; mi < result.meshes.length; mi++) {
    const mesh = result.meshes[mi];
    const pos = mesh.attributes.position;
    const norm = mesh.attributes.normal;
    if (!pos || !pos.array || pos.array.length === 0) continue;
    
    const verts = new Float32Array(pos.array);
    const normals = norm && norm.array ? new Float32Array(norm.array) : null;
    const indices = mesh.index && mesh.index.array ? new Uint32Array(mesh.index.array) : null;
    
    let color = BODY_COLORS[mi % BODY_COLORS.length];
    if (mesh.color) {
      const c = mesh.color;
      const col = new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255);
      if (col.getHSL({}).l < 0.15) col.offsetHSL(0, 0, 0.35);
      color = col.getHex();
    }
    
    const vertCount = verts.length / 3;
    const faceCount = indices ? indices.length / 3 : vertCount / 3;
    totalVerts += vertCount;
    totalFaces += faceCount;
    
    bodies.push({ vertices: verts, indices, normals, color, vertCount, faceCount });
  }
  
  if (bodies.length === 0) throw new Error('Geen geometrie gevonden in CAD bestand');
  
  parsedData = { bodies, totalVerts, totalFaces, fileSize: buffer.byteLength };
}

async function handleModelFile(buffer, fileName) {
  showProgress('3D model laden...', 10);
  showProgress('Assimp WASM initialiseren...', 30);
  
  const ajs = await assimpjs();
  showProgress('Model parsen...' ,50);
  
  // Convert to assjson (JSON format)
  const fileList = new ajs.FileList();
  fileList.AddFile(fileName, new Uint8Array(buffer));
  const result = ajs.ConvertFileList(fileList, 'assjson');
  
  if (!result.IsSuccess() || result.FileCount() === 0) {
    throw new Error(`Assimp konversie faalde: ${result.GetErrorCode()}`);
  }
  
  // Parse result
  const resultFile = result.GetFile(0);
  const jsonStr = new TextDecoder().decode(resultFile.GetContent());
  const assimpJson = JSON.parse(jsonStr);
  
  // Extract materials
  const materialsMap = {};
  if (assimpJson.materials && assimpJson.materials.length > 0) {
    for (let mi = 0; mi < assimpJson.materials.length; mi++) {
      const mat = assimpJson.materials[mi];
      let color = BODY_COLORS[mi % BODY_COLORS.length];
      
      // Try to extract color from material properties
      if (mat.properties) {
        for (const prop of mat.properties) {
          if (prop.key === '$clr.diffuse' && prop.value && prop.value.length >= 3) {
            const col = new THREE.Color(prop.value[0] || 0, prop.value[1] || 0, prop.value[2] || 0);
            if (col.getHSL({}).l < 0.15) col.offsetHSL(0, 0, 0.35);
            color = col.getHex();
            break;
          }
        }
      }
      
      materialsMap[mi] = { name: mat.name || `Material ${mi}`, color };
    }
  }
  
  // Extract meshes from assimp JSON
  const bodies = [];
  let totalVerts = 0;
  let totalFaces = 0;
  
  if (!assimpJson.meshes || assimpJson.meshes.length === 0) {
    throw new Error('Geen meshes in model gevonden');
  }
  
  for (let mi = 0; mi < assimpJson.meshes.length; mi++) {
    const meshData = assimpJson.meshes[mi];
    if (!meshData.vertices || meshData.vertices.length === 0) continue;
    
    // Convert flat vertex array to Float32Array
    const vertices = new Float32Array(meshData.vertices);
    
    // Convert faces (array of arrays) to flat indices
    let indices = null;
    if (meshData.faces && meshData.faces.length > 0) {
      const indicesList = [];
      for (const face of meshData.faces) {
        if (Array.isArray(face) && face.length >= 3) {
          // Fan-triangulatie: [0,1,2,3,4] → [0,1,2], [0,2,3], [0,3,4]
          for (let i = 1; i < face.length - 1; i++) {
            indicesList.push(face[0], face[i], face[i + 1]);
          }
        }
      }
      indices = new Uint32Array(indicesList);
    }
    
    // Convert normals if present
    let normals = null;
    if (meshData.normals && meshData.normals.length > 0) {
      normals = new Float32Array(meshData.normals);
    }
    
    // Color from material or palette
    const matIdx = meshData.materialindex !== undefined ? meshData.materialindex : mi;
    const matData = materialsMap[matIdx] || { name: `Mesh ${mi}`, color: BODY_COLORS[mi % BODY_COLORS.length] };
    
    const vertCount = vertices.length / 3;
    const faceCount = indices ? indices.length / 3 : vertCount / 3;
    totalVerts += vertCount;
    totalFaces += faceCount;
    
    bodies.push({ vertices, indices, normals, color: matData.color, material: matData.name, vertCount, faceCount });
  }
  
  if (bodies.length === 0) throw new Error('Geen geometrie gevonden in model');
  
  // Count nodes in hierarchy
  function countNodes(node) {
    let c = 1;
    if (node.children) for (const child of node.children) c += countNodes(child);
    return c;
  }
  const nodeCount = assimpJson.rootnode ? countNodes(assimpJson.rootnode) : bodies.length;

  parsedData = { bodies, totalVerts, totalFaces, fileSize: buffer.byteLength, materials: materialsMap, hierarchy: nodeCount };
}

// --- Mesh Info ---
function updateMeshInfo() {
  if (!parsedData) return;
  meshInfo.classList.add('active');
  document.getElementById('infoVerts').textContent = parsedData.totalVerts.toLocaleString('nl-NL');
  document.getElementById('infoFaces').textContent = parsedData.totalFaces.toLocaleString('nl-NL');
  document.getElementById('infoBodies').textContent = parsedData.bodies.length;
  document.getElementById('infoSize').textContent = formatSize(parsedData.fileSize);
  
  // Add material count if available
  if (parsedData.materials && Object.keys(parsedData.materials).length > 0) {
    let matRow = document.getElementById('infoMaterials');
    if (!matRow) {
      matRow = document.createElement('div');
      matRow.className = 'row';
      matRow.id = 'infoMaterials';
      matRow.innerHTML = '<span class="label">Materialen</span><span class="value"></span>';
      document.getElementById('meshInfo').appendChild(matRow);
    }
    matRow.querySelector('.value').textContent = Object.keys(parsedData.materials).length;
  }
  
  // Compute bounding box from all bodies
  const box = new THREE.Box3();
  for (const body of parsedData.bodies) {
    const v = body.vertices;
    for (let i = 0; i < v.length; i += 3) {
      box.expandByPoint(new THREE.Vector3(v[i], v[i+1], v[i+2]));
    }
  }
  const size = new THREE.Vector3();
  box.getSize(size);
  document.getElementById('infoDims').textContent = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)}`;
  
  // Add mesh hierarchy if present
  if (parsedData.bodies.length > 10) {
    let hierarchyRow = document.getElementById('infoHierarchy');
    if (!hierarchyRow) {
      hierarchyRow = document.createElement('div');
      hierarchyRow.className = 'row';
      hierarchyRow.id = 'infoHierarchy';
      hierarchyRow.innerHTML = '<span class="label">Meshes</span><span class="value"></span>';
      document.getElementById('meshInfo').appendChild(hierarchyRow);
    }
    hierarchyRow.querySelector('.value').textContent = `${parsedData.bodies.length} onderdelen`;
  }
}

// --- 3D Preview ---
function cleanupPreview() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
  if (meshGroup) {
    meshGroup.children.forEach(m => {
      m.geometry.dispose();
      m.material.dispose();
    });
    meshGroup = null;
  }
  if (renderer) { renderer.dispose(); renderer = null; }
  scene = null; camera = null; controls = null;
  wireframeOn = false;
  btnWireframe.classList.remove('active');
}

function setupPreview() {
  if (!parsedData) return;

  cleanupPreview();

  // Clear existing (keep toolbar)
  const toolbar = previewToolbar;
  previewPanel.innerHTML = '';
  previewPanel.appendChild(toolbar);
  toolbar.style.display = 'flex';
  
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  
  const w = previewPanel.clientWidth;
  const h = previewPanel.clientHeight || 400;
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  previewPanel.appendChild(renderer.domElement);
  
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  
  // Create group for all body meshes
  meshGroup = new THREE.Group();
  
  for (const body of parsedData.bodies) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(body.vertices, 3));
    if (body.normals && body.normals.length > 0) {
      geo.setAttribute('normal', new THREE.BufferAttribute(body.normals, 3));
    }
    if (body.indices && body.indices.length > 0) {
      geo.setIndex(new THREE.BufferAttribute(body.indices, 1));
    }
    if (!body.normals || body.normals.length === 0) geo.computeVertexNormals();
    
    const mat = new THREE.MeshStandardMaterial({
      color: body.color,
      metalness: 0.3,
      roughness: 0.6,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.userData.baseColor = body.color;
    meshGroup.add(m);
  }
  scene.add(meshGroup);
  
  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
  dir1.position.set(5, 10, 7);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.3);
  dir2.position.set(-5, -5, -5);
  scene.add(dir2);
  
  // Fit camera to all geometry
  const box = new THREE.Box3().setFromObject(meshGroup);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const dist = sphere.radius * 2.5;
  camera.position.set(sphere.center.x + dist, sphere.center.y + dist * 0.5, sphere.center.z + dist);
  controls.target.copy(sphere.center);
  controls.update();
  
  // Save initial camera for reset
  initialCamPos = camera.position.clone();
  initialTarget = controls.target.clone();
  
  // Grid
  const grid = new THREE.GridHelper(sphere.radius * 4, 20, 0x333333, 0x222222);
  grid.position.y = box.min.y;
  scene.add(grid);
  
  // Render loop
  function animate() {
    animFrameId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  // Resize
  const ro = new ResizeObserver(() => {
    const w2 = previewPanel.clientWidth;
    const h2 = previewPanel.clientHeight;
    if (w2 && h2) {
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
      renderer.setSize(w2, h2);
    }
  });
  ro.observe(previewPanel);
  resizeObserver = ro;
}

// --- Wireframe toggle ---
function toggleWireframe() {
  if (!meshGroup) return;
  wireframeOn = !wireframeOn;
  btnWireframe.classList.toggle('active', wireframeOn);
  meshGroup.children.forEach(m => {
    m.material.wireframe = wireframeOn;
  });
}

// --- Camera reset ---
function resetCamera() {
  if (!camera || !initialCamPos) return;
  camera.position.copy(initialCamPos);
  controls.target.copy(initialTarget);
  controls.update();
}

btnWireframe.addEventListener('click', toggleWireframe);
btnResetCam.addEventListener('click', resetCamera);

// --- Keyboard shortcuts ---
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'w' || e.key === 'W') toggleWireframe();
  if (e.key === 'r' || e.key === 'R') resetCamera();
});

// --- Convert ---
convertBtn.addEventListener('click', async () => {
  if (!parsedData) return;
  
  const formats = [...document.querySelectorAll('.format-btn.active')].map(b => b.dataset.format);
  if (formats.length === 0) { showError('Selecteer minstens één formaat.'); return; }
  hideError();
  // Revoke oude Object URLs
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  results.innerHTML = '';
  
  const baseName = loadedFile.name.replace(/\.(stp|step|skp|fbx|obj|3ds|dae|ply|blend|gltf|glb|iges|igs|stl|dxf|usdz)$/i, '');
  
  for (const fmt of formats) {
    showProgress(`Exporteren naar ${fmt.toUpperCase()}...`, 50);
    try {
      let blob, ext;
      switch (fmt) {
        case 'obj': [blob, ext] = [exportOBJ(), 'obj']; break;
        case 'stl': [blob, ext] = [exportSTL(), 'stl']; break;
        case 'dxf': [blob, ext] = [exportDXF(), 'dxf']; break;
        case 'glb': [blob, ext] = [await exportGLB(), 'glb']; break;
        case 'gltf': [blob, ext] = [await exportGLTF(), 'gltf']; break;
        case 'ply': [blob, ext] = [exportPLY(), 'ply']; break;
        case 'dae': [blob, ext] = [exportDAE(), 'dae']; break;
        case 'skp': [blob, ext] = [exportSKP(), 'skp.rb']; break;
      }
      addResult(fmt.toUpperCase(), `${baseName}.${ext}`, blob);
    } catch (err) {
      showError(`Fout bij ${fmt}: ${err.message}`);
    }
  }
  showProgress('Alle conversies klaar!', 100);
  setTimeout(() => progress.classList.remove('active'), 500);
});

// --- Helper: get merged mesh data ---
function getMergedMesh() {
  const allVerts = [];
  const allIndices = [];
  const allNormals = [];
  let vertOffset = 0;
  
  for (const body of parsedData.bodies) {
    for (let i = 0; i < body.vertices.length; i++) allVerts.push(body.vertices[i]);
    if (body.normals) {
      for (let i = 0; i < body.normals.length; i++) allNormals.push(body.normals[i]);
    }
    if (body.indices) {
      for (let i = 0; i < body.indices.length; i++) {
        allIndices.push(body.indices[i] + vertOffset);
      }
    } else {
      // Genereer sequentiële indices voor bodies zonder index buffer
      for (let i = 0; i < body.vertCount; i++) {
        allIndices.push(i + vertOffset);
      }
    }
    vertOffset += body.vertCount;
  }
  return {
    vertices: new Float32Array(allVerts),
    indices: new Uint32Array(allIndices),
    normals: new Float32Array(allNormals),
    materials: parsedData.bodies.map((b, i) => ({ name: b.material || `Mesh ${i}`, color: b.color })),
  };
}

// --- Exporters ---
function exportOBJ() {
  const { vertices: v, indices: idx, normals: n } = getMergedMesh();
  let obj = '# STEP Converter — OBJ Export\n';
  
  for (let i = 0; i < v.length; i += 3) {
    obj += `v ${v[i].toFixed(6)} ${v[i+1].toFixed(6)} ${v[i+2].toFixed(6)}\n`;
  }
  if (n.length > 0) {
    for (let i = 0; i < n.length; i += 3) {
      obj += `vn ${n[i].toFixed(6)} ${n[i+1].toFixed(6)} ${n[i+2].toFixed(6)}\n`;
    }
  }
  if (idx.length > 0) {
    for (let i = 0; i < idx.length; i += 3) {
      if (n.length > 0) {
        obj += `f ${idx[i]+1}//${idx[i]+1} ${idx[i+1]+1}//${idx[i+1]+1} ${idx[i+2]+1}//${idx[i+2]+1}\n`;
      } else {
        obj += `f ${idx[i]+1} ${idx[i+1]+1} ${idx[i+2]+1}\n`;
      }
    }
  }
  return new Blob([obj], { type: 'text/plain' });
}

function exportSTL() {
  const { vertices: v, indices: idx } = getMergedMesh();
  const faceCount = idx.length / 3;
  const bufSize = 84 + faceCount * 50;
  const buf = new ArrayBuffer(bufSize);
  const view = new DataView(buf);
  const header = new Uint8Array(buf, 0, 80);
  header.set(new TextEncoder().encode('STEP Converter — STL Export'));
  view.setUint32(80, faceCount, true);
  
  let offset = 84;
  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i] * 3, i1 = idx[i+1] * 3, i2 = idx[i+2] * 3;
    const ax = v[i1] - v[i0], ay = v[i1+1] - v[i0+1], az = v[i1+2] - v[i0+2];
    const bx = v[i2] - v[i0], by = v[i2+1] - v[i0+1], bz = v[i2+2] - v[i0+2];
    const nx = ay*bz - az*by, ny = az*bx - ax*bz, nz = ax*by - ay*bx;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
    
    view.setFloat32(offset, nx/len, true); offset += 4;
    view.setFloat32(offset, ny/len, true); offset += 4;
    view.setFloat32(offset, nz/len, true); offset += 4;
    
    for (const vi of [i0, i1, i2]) {
      view.setFloat32(offset, v[vi], true); offset += 4;
      view.setFloat32(offset, v[vi+1], true); offset += 4;
      view.setFloat32(offset, v[vi+2], true); offset += 4;
    }
    view.setUint16(offset, 0, true); offset += 2;
  }
  return new Blob([buf], { type: 'application/octet-stream' });
}

function exportDXF() {
  const { vertices: v, indices: idx } = getMergedMesh();
  let dxf = '0\nSECTION\n2\nHEADER\n0\nENDSEC\n';
  dxf += '0\nSECTION\n2\nTABLES\n';
  dxf += '0\nTABLE\n2\nLAYER\n70\n1\n';
  dxf += '0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n';
  dxf += '0\nENDTAB\n0\nENDSEC\n';
  dxf += '0\nSECTION\n2\nENTITIES\n';
  
  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i] * 3, i1 = idx[i+1] * 3, i2 = idx[i+2] * 3;
    dxf += '0\n3DFACE\n8\n0\n';
    dxf += `10\n${v[i0].toFixed(6)}\n20\n${v[i0+1].toFixed(6)}\n30\n${v[i0+2].toFixed(6)}\n`;
    dxf += `11\n${v[i1].toFixed(6)}\n21\n${v[i1+1].toFixed(6)}\n31\n${v[i1+2].toFixed(6)}\n`;
    dxf += `12\n${v[i2].toFixed(6)}\n22\n${v[i2+1].toFixed(6)}\n32\n${v[i2+2].toFixed(6)}\n`;
    dxf += `13\n${v[i2].toFixed(6)}\n23\n${v[i2+1].toFixed(6)}\n33\n${v[i2+2].toFixed(6)}\n`;
  }
  dxf += '0\nENDSEC\n0\nEOF\n';
  return new Blob([dxf], { type: 'application/dxf' });
}

async function exportGLB() {
  if (!meshGroup) throw new Error('Geen 3D scene beschikbaar');
  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(meshGroup, { binary: true });
  return new Blob([glb], { type: 'model/gltf-binary' });
}

async function exportGLTF() {
  if (!meshGroup) throw new Error('Geen 3D scene beschikbaar');
  const exporter = new GLTFExporter();
  const gltf = await exporter.parseAsync(meshGroup, { binary: false });
  const json = JSON.stringify(gltf, null, 2);
  return new Blob([json], { type: 'model/gltf+json' });
}

function exportSKP() {
  const merged = getMergedMesh();
  const v = merged.vertices;
  const idx = merged.indices;
  const lines = [];
  lines.push('# SketchUp Ruby Script — gegenereerd door 3D Converter');
  lines.push('# Open SketchUp → Window → Ruby Console → load dit bestand');
  lines.push('model = Sketchup.active_model');
  lines.push('model.start_operation("Import 3D Model", true)');
  lines.push('ents = model.active_entities');
  lines.push('mesh = Geom::PolygonMesh.new');
  
  for (let i = 0; i < v.length; i += 3) {
    lines.push('mesh.add_point(Geom::Point3d.new(' + v[i].toFixed(4) + ', ' + v[i+1].toFixed(4) + ', ' + v[i+2].toFixed(4) + '))');
  }
  
  if (idx && idx.length > 0) {
    for (let i = 0; i < idx.length; i += 3) {
      lines.push('mesh.add_polygon(' + (idx[i]+1) + ', ' + (idx[i+1]+1) + ', ' + (idx[i+2]+1) + ')');
    }
  } else {
    const vertCount = v.length / 3;
    for (let i = 0; i < vertCount; i += 3) {
      lines.push('mesh.add_polygon(' + (i+1) + ', ' + (i+2) + ', ' + (i+3) + ')');
    }
  }
  
  lines.push('group = ents.add_group');
  lines.push('group.entities.fill_from_mesh(mesh, true, Geom::PolygonMesh::AUTO_SOFTEN)');
  lines.push('model.commit_operation');
  lines.push('puts "Model imported: #{mesh.count_points} vertices, #{mesh.count_polygons} faces"');
  
  const rb = lines.join('\n') + '\n';
  return new Blob([rb], { type: 'text/plain' });
}

function exportDAE() {
  const { vertices: v, indices: idx, normals: n, materials: mats } = getMergedMesh();
  const vertCount = v.length / 3;
  const faceCount = idx.length / 3;

  let posArr = '';
  for (let i = 0; i < v.length; i++) posArr += v[i].toFixed(6) + ' ';
  let normArr = '';
  if (n.length > 0) for (let i = 0; i < n.length; i++) normArr += n[i].toFixed(6) + ' ';

  let faces = '';
  for (let i = 0; i < idx.length; i += 3) {
    if (n.length > 0) {
      faces += `${idx[i]} ${idx[i]} ${idx[i+1]} ${idx[i+1]} ${idx[i+2]} ${idx[i+2]} `;
    } else {
      faces += `${idx[i]} ${idx[i+1]} ${idx[i+2]} `;
    }
  }

  const inputStride = n.length > 0
    ? '<input semantic="VERTEX" source="#mesh-vertices" offset="0"/><input semantic="NORMAL" source="#mesh-normals" offset="1"/>'
    : '<input semantic="VERTEX" source="#mesh-vertices" offset="0"/>';
  const vcount = Array(faceCount).fill('3').join(' ');

  let dae = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><created>${new Date().toISOString()}</created><up_axis>Y_UP</up_axis></asset>
  <library_geometries>
    <geometry id="mesh" name="mesh">
      <mesh>
        <source id="mesh-positions">
          <float_array id="mesh-positions-array" count="${v.length}">${posArr.trim()}</float_array>
          <technique_common><accessor source="#mesh-positions-array" count="${vertCount}" stride="3">
            <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
          </accessor></technique_common>
        </source>`;
  if (n.length > 0) {
    dae += `
        <source id="mesh-normals">
          <float_array id="mesh-normals-array" count="${n.length}">${normArr.trim()}</float_array>
          <technique_common><accessor source="#mesh-normals-array" count="${vertCount}" stride="3">
            <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
          </accessor></technique_common>
        </source>`;
  }
  dae += `
        <vertices id="mesh-vertices"><input semantic="POSITION" source="#mesh-positions"/></vertices>
        <polylist count="${faceCount}">${inputStride}<vcount>${vcount}</vcount><p>${faces.trim()}</p></polylist>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <node id="Model" name="Model" type="NODE">
        <instance_geometry url="#mesh"/>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>`;
  return new Blob([dae], { type: 'model/vnd.collada+xml' });
}

function exportPLY() {
  const { vertices: v, indices: idx, normals: n } = getMergedMesh();
  const vertCount = v.length / 3;
  const faceCount = idx.length / 3;
  
  let ply = 'ply\nformat ascii 1.0\n';
  ply += `element vertex ${vertCount}\n`;
  ply += 'property float x\nproperty float y\nproperty float z\n';
  if (n.length > 0) {
    ply += 'property float nx\nproperty float ny\nproperty float nz\n';
  }
  ply += `element face ${faceCount}\n`;
  ply += 'property list uchar int vertex_indices\n';
  ply += 'end_header\n';
  
  for (let i = 0; i < v.length; i += 3) {
    ply += `${v[i].toFixed(6)} ${v[i+1].toFixed(6)} ${v[i+2].toFixed(6)}`;
    if (n.length > 0) {
      ply += ` ${n[i].toFixed(6)} ${n[i+1].toFixed(6)} ${n[i+2].toFixed(6)}`;
    }
    ply += '\n';
  }
  for (let i = 0; i < idx.length; i += 3) {
    ply += `3 ${idx[i]} ${idx[i+1]} ${idx[i+2]}\n`;
  }
  return new Blob([ply], { type: 'application/x-ply' });
}

// --- Utils ---
function addResult(format, filename, blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `
    <div class="format">${format}</div>
    <div class="info">${filename} — ${formatSize(blob.size)}</div>
    <a href="${url}" download="${filename}">⬇ Download</a>
  `;
  results.appendChild(card);
}

function showProgress(text, pct) {
  progress.classList.add('active');
  progressFill.style.width = pct + '%';
  progressText.textContent = text;
  spinner.style.display = pct >= 100 ? 'none' : 'block';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.add('active');
}
function hideError() { errorBox.classList.remove('active'); }

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
