import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- State ---
let loadedFile = null;
let parsedMesh = null; // { vertices: Float32Array, indices: Uint32Array, normals: Float32Array }
let scene, camera, renderer, controls;

// --- DOM ---
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileName = document.getElementById('fileName');
const convertBtn = document.getElementById('convertBtn');
const progress = document.getElementById('progress');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const results = document.getElementById('results');
const errorBox = document.getElementById('errorBox');
const previewPanel = document.getElementById('previewPanel');

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

async function handleFile(file) {
  const ext = file.name.toLowerCase();
  if (!ext.endsWith('.stp') && !ext.endsWith('.step')) {
    showError('Alleen .stp/.step bestanden worden ondersteund.');
    return;
  }
  hideError();
  loadedFile = file;
  fileName.textContent = `${file.name} (${formatSize(file.size)})`;
  convertBtn.disabled = false;
  
  // Parse immediately for preview
  showProgress('STEP bestand laden...', 10);
  try {
    const buffer = await file.arrayBuffer();
    showProgress('OpenCascade WASM initialiseren...', 30);
    const occt = await occtimportjs();
    showProgress('Geometrie parsen...', 50);
    const result = occt.ReadStepFile(new Uint8Array(buffer), null);
    if (!result.success) throw new Error('Kan STEP bestand niet parsen');
    
    // Merge all meshes
    const allVerts = [];
    const allIndices = [];
    const allNormals = [];
    let vertOffset = 0;
    
    for (const mesh of result.meshes) {
      for (const attr of mesh.attributes) {
        if (attr.name === 'position') {
          for (let i = 0; i < attr.array.length; i++) allVerts.push(attr.array[i]);
        }
        if (attr.name === 'normal') {
          for (let i = 0; i < attr.array.length; i++) allNormals.push(attr.array[i]);
        }
      }
      if (mesh.index) {
        for (let i = 0; i < mesh.index.array.length; i++) {
          allIndices.push(mesh.index.array[i] + vertOffset);
        }
      }
      vertOffset += (mesh.attributes.find(a => a.name === 'position')?.array.length || 0) / 3;
    }
    
    parsedMesh = {
      vertices: new Float32Array(allVerts),
      indices: new Uint32Array(allIndices),
      normals: new Float32Array(allNormals),
      vertexCount: allVerts.length / 3,
      faceCount: allIndices.length / 3
    };
    
    showProgress('3D preview laden...', 80);
    setupPreview();
    showProgress('Klaar!', 100);
    setTimeout(() => { progress.classList.remove('active'); }, 500);
  } catch (err) {
    showError(`Fout bij laden: ${err.message}`);
    progress.classList.remove('active');
  }
}

// --- 3D Preview ---
function setupPreview() {
  if (!parsedMesh) return;
  
  // Clear existing
  previewPanel.innerHTML = '';
  
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  
  const w = previewPanel.clientWidth;
  const h = previewPanel.clientHeight || 400;
  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(window.devicePixelRatio);
  previewPanel.appendChild(renderer.domElement);
  
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  
  // Geometry
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(parsedMesh.vertices, 3));
  if (parsedMesh.normals.length > 0) {
    geo.setAttribute('normal', new THREE.BufferAttribute(parsedMesh.normals, 3));
  }
  if (parsedMesh.indices.length > 0) {
    geo.setIndex(new THREE.BufferAttribute(parsedMesh.indices, 1));
  }
  if (parsedMesh.normals.length === 0) geo.computeVertexNormals();
  
  const mat = new THREE.MeshStandardMaterial({ color: 0x4fc3f7, metalness: 0.3, roughness: 0.6, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);
  
  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(5, 10, 7);
  scene.add(dir);
  scene.add(new THREE.DirectionalLight(0xffffff, 0.3).position.set(-5, -5, -5));
  
  // Fit camera
  geo.computeBoundingSphere();
  const sphere = geo.boundingSphere;
  const dist = sphere.radius * 2.5;
  camera.position.set(sphere.center.x + dist, sphere.center.y + dist * 0.5, sphere.center.z + dist);
  controls.target.copy(sphere.center);
  controls.update();
  
  // Grid
  const grid = new THREE.GridHelper(sphere.radius * 4, 20, 0x333333, 0x222222);
  grid.position.y = sphere.center.y - sphere.radius;
  scene.add(grid);
  
  // Render loop
  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
  
  // Resize
  const ro = new ResizeObserver(() => {
    const w2 = previewPanel.clientWidth;
    const h2 = previewPanel.clientHeight;
    camera.aspect = w2 / h2;
    camera.updateProjectionMatrix();
    renderer.setSize(w2, h2);
  });
  ro.observe(previewPanel);
}

// --- Convert ---
convertBtn.addEventListener('click', async () => {
  if (!parsedMesh) return;
  
  const formats = [...document.querySelectorAll('.format-btn.active')].map(b => b.dataset.format);
  if (formats.length === 0) { showError('Selecteer minstens één formaat.'); return; }
  hideError();
  results.innerHTML = '';
  
  const baseName = loadedFile.name.replace(/\.(stp|step)$/i, '');
  
  for (const fmt of formats) {
    showProgress(`Exporteren naar ${fmt.toUpperCase()}...`, 50);
    try {
      let blob, ext;
      switch (fmt) {
        case 'obj': [blob, ext] = [exportOBJ(), 'obj']; break;
        case 'stl': [blob, ext] = [exportSTL(), 'stl']; break;
        case 'dxf': [blob, ext] = [exportDXF(), 'dxf']; break;
      }
      addResult(fmt.toUpperCase(), `${baseName}.${ext}`, blob);
    } catch (err) {
      showError(`Fout bij ${fmt}: ${err.message}`);
    }
  }
  showProgress('Alle conversies klaar!', 100);
  setTimeout(() => progress.classList.remove('active'), 500);
});

// --- Exporters ---
function exportOBJ() {
  const v = parsedMesh.vertices;
  const idx = parsedMesh.indices;
  const n = parsedMesh.normals;
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
      const hasN = n.length > 0;
      if (hasN) {
        obj += `f ${idx[i]+1}//${idx[i]+1} ${idx[i+1]+1}//${idx[i+1]+1} ${idx[i+2]+1}//${idx[i+2]+1}\n`;
      } else {
        obj += `f ${idx[i]+1} ${idx[i+1]+1} ${idx[i+2]+1}\n`;
      }
    }
  }
  return new Blob([obj], { type: 'text/plain' });
}

function exportSTL() {
  const v = parsedMesh.vertices;
  const idx = parsedMesh.indices;
  const faceCount = idx.length / 3;
  
  // Binary STL: 80 header + 4 bytes face count + 50 bytes per face
  const bufSize = 84 + faceCount * 50;
  const buf = new ArrayBuffer(bufSize);
  const view = new DataView(buf);
  const header = new Uint8Array(buf, 0, 80);
  const enc = new TextEncoder();
  header.set(enc.encode('STEP Converter — STL Export'));
  view.setUint32(80, faceCount, true);
  
  let offset = 84;
  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i] * 3, i1 = idx[i+1] * 3, i2 = idx[i+2] * 3;
    // Compute normal
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
  const v = parsedMesh.vertices;
  const idx = parsedMesh.indices;
  let dxf = '0\nSECTION\n2\nHEADER\n0\nENDSEC\n';
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

// --- Utils ---
function addResult(format, filename, blob) {
  const url = URL.createObjectURL(blob);
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
