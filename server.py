#!/usr/bin/env python3
"""
3D Converter — Standalone Windows App
Serveert de web-interface + native SKP conversie via SketchUp C SDK.

Dubbelklik om te starten → opent automatisch in je browser.

Dex — maart 2026
"""

import ctypes
import ctypes.wintypes
import os
import sys
import json
import tempfile
import webbrowser
import mimetypes
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote

PORT = 7890

# PyInstaller bundled of gewone Python?
if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Web bestanden: probeer 'web' submap, anders root (voor repo layout)
WEB_DIR = os.path.join(BASE_DIR, "web")
if not os.path.isdir(WEB_DIR):
    WEB_DIR = BASE_DIR

# ─── SketchUp C API ──────────────────────────────────────────────────────────

SU_ERROR_NONE = 0

SU_MODEL_VERSION = {
    "3": 0, "4": 1, "5": 2, "6": 3, "7": 4, "8": 5,
    "2013": 6, "2014": 7, "2015": 8, "2016": 9,
    "2017": 10, "2018": 11, "2019": 12, "2020": 13, "2021": 14,
}


class SURef(ctypes.Structure):
    _fields_ = [("ptr", ctypes.c_void_p)]


class SUPoint3D(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double), ("z", ctypes.c_double)]


class SUColor(ctypes.Structure):
    _fields_ = [("red", ctypes.c_ubyte), ("green", ctypes.c_ubyte), ("blue", ctypes.c_ubyte), ("alpha", ctypes.c_ubyte)]


class SUMaterialInput(ctypes.Structure):
    _fields_ = [
        ("num_uv_coords", ctypes.c_size_t),
        ("uv_coords", SUPoint3D * 4),
        ("vertex_indices", ctypes.c_size_t * 4),
        ("material", SURef),
    ]


def find_sketchup_dll():
    pf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
    pf86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    candidates = []

    # Patroon 1: C:\Program Files\SketchUp\SketchUp 20XX\SketchUp\SketchUpAPI.dll
    for root in [os.path.join(pf, "SketchUp"), os.path.join(pf86, "SketchUp")]:
        if os.path.isdir(root):
            for entry in os.listdir(root):
                dll = os.path.join(root, entry, "SketchUp", "SketchUpAPI.dll")
                if os.path.isfile(dll):
                    candidates.append((entry, dll))

    # Patroon 2: C:\Program Files\SketchUp 20XX\SketchUp\SketchUpAPI.dll (oudere versies)
    for base in [pf, pf86]:
        if os.path.isdir(base):
            for entry in os.listdir(base):
                if "sketchup" in entry.lower():
                    dll = os.path.join(base, entry, "SketchUp", "SketchUpAPI.dll")
                    if os.path.isfile(dll):
                        candidates.append((entry, dll))
                    # Patroon 3: DLL direct in de hoofdmap
                    dll2 = os.path.join(base, entry, "SketchUpAPI.dll")
                    if os.path.isfile(dll2):
                        candidates.append((entry, dll2))

    # Deduplicate en sorteer (nieuwste versie eerst)
    seen = set()
    unique = []
    for name, path in candidates:
        if path not in seen:
            seen.add(path)
            unique.append((name, path))
    unique.sort(key=lambda x: x[0], reverse=True)
    return unique[0] if unique else None


class SketchUpAPI:
    def __init__(self, dll_path):
        self.dll = ctypes.CDLL(dll_path)
        self._setup()

    def _setup(self):
        d = self.dll
        for name, res, args in [
            ("SUInitialize", ctypes.c_int, []),
            ("SUTerminate", ctypes.c_int, []),
            ("SUModelCreate", ctypes.c_int, [ctypes.POINTER(SURef)]),
            ("SUModelRelease", ctypes.c_int, [ctypes.POINTER(SURef)]),
            ("SUModelSaveToFile", ctypes.c_int, [SURef, ctypes.c_char_p]),
            ("SUModelSaveToFileWithVersion", ctypes.c_int, [SURef, ctypes.c_char_p, ctypes.c_int]),
            ("SUModelGetEntities", ctypes.c_int, [SURef, ctypes.POINTER(SURef)]),
            ("SUModelAddMaterials", ctypes.c_int, [SURef, ctypes.c_size_t, ctypes.POINTER(SURef)]),
            ("SUGeometryInputCreate", ctypes.c_int, [ctypes.POINTER(SURef)]),
            ("SUGeometryInputRelease", ctypes.c_int, [ctypes.POINTER(SURef)]),
            ("SUGeometryInputAddVertex", ctypes.c_int, [SURef, ctypes.POINTER(SUPoint3D)]),
            ("SUGeometryInputAddFace", ctypes.c_int, [SURef, ctypes.POINTER(SURef), ctypes.POINTER(SURef)]),
            ("SUGeometryInputFaceSetFrontMaterial", ctypes.c_int, [SURef, ctypes.c_size_t, ctypes.POINTER(SUMaterialInput)]),
            ("SULoopInputCreate", ctypes.c_int, [ctypes.POINTER(SURef)]),
            ("SULoopInputRelease", ctypes.c_int, [ctypes.POINTER(SURef)]),
            ("SULoopInputAddVertexIndex", ctypes.c_int, [SURef, ctypes.c_size_t]),
            ("SUEntitiesFill", ctypes.c_int, [SURef, SURef, ctypes.c_bool]),
            ("SUGroupCreate", ctypes.c_int, [ctypes.POINTER(SURef)]),
            ("SUGroupGetEntities", ctypes.c_int, [SURef, ctypes.POINTER(SURef)]),
            ("SUGroupSetName", ctypes.c_int, [SURef, ctypes.c_char_p]),
            ("SUEntitiesAddGroup", ctypes.c_int, [SURef, SURef]),
            ("SUMaterialCreate", ctypes.c_int, [ctypes.POINTER(SURef)]),
            ("SUMaterialSetName", ctypes.c_int, [SURef, ctypes.c_char_p]),
            ("SUMaterialSetColor", ctypes.c_int, [SURef, ctypes.POINTER(SUColor)]),
        ]:
            fn = getattr(d, name)
            fn.restype = res
            fn.argtypes = args

    def ok(self, r, name=""):
        if r != SU_ERROR_NONE:
            raise RuntimeError(f"SU fout {name}: {r}")

    def convert_obj_to_skp(self, obj_text, version=None):
        """OBJ tekst -> SKP bytes."""
        self.dll.SUInitialize()
        try:
            model = SURef()
            self.ok(self.dll.SUModelCreate(ctypes.byref(model)))
            ents = SURef()
            self.ok(self.dll.SUModelGetEntities(model, ctypes.byref(ents)))

            # Parse OBJ
            vertices, objects, colors, face_mats = self._parse_obj(obj_text)
            if not vertices:
                raise ValueError("Geen vertices in OBJ")

            # Materials
            materials = {}
            mat_list = []
            for name, (r, g, b) in colors.items():
                mat = SURef()
                self.ok(self.dll.SUMaterialCreate(ctypes.byref(mat)))
                self.ok(self.dll.SUMaterialSetName(mat, name.encode("utf-8")))
                c = SUColor(r, g, b, 255)
                self.ok(self.dll.SUMaterialSetColor(mat, ctypes.byref(c)))
                materials[name] = mat
                mat_list.append(mat)

            palette = [(66,133,244),(234,67,53),(251,188,4),(52,168,83),(171,71,188),(255,112,67),(0,172,193),(124,179,66)]
            for i, obj in enumerate(objects):
                key = f"mat_{obj['name']}"
                if key not in materials:
                    r, g, b = palette[i % len(palette)]
                    mat = SURef()
                    self.ok(self.dll.SUMaterialCreate(ctypes.byref(mat)))
                    self.ok(self.dll.SUMaterialSetName(mat, key.encode("utf-8")))
                    c = SUColor(r, g, b, 255)
                    self.ok(self.dll.SUMaterialSetColor(mat, ctypes.byref(c)))
                    materials[key] = mat
                    mat_list.append(mat)

            if mat_list:
                arr = (SURef * len(mat_list))(*mat_list)
                self.ok(self.dll.SUModelAddMaterials(model, len(mat_list), arr))

            # Geometry per object
            for oi, obj in enumerate(objects):
                gi = SURef()
                self.ok(self.dll.SUGeometryInputCreate(ctypes.byref(gi)))

                used = set()
                for face in obj["faces"]:
                    for vi in face:
                        used.add(vi)

                vmap = {}
                for vi in sorted(used):
                    if 1 <= vi <= len(vertices):
                        vmap[vi] = len(vmap)
                        x, y, z = vertices[vi - 1]
                        pt = SUPoint3D(x / 25.4, y / 25.4, z / 25.4)
                        self.ok(self.dll.SUGeometryInputAddVertex(gi, ctypes.byref(pt)))

                fc = 0
                for fi, face in enumerate(obj["faces"]):
                    try:
                        tris = [face] if len(face) <= 4 else [[face[0], face[j], face[j+1]] for j in range(1, len(face)-1)]
                        for tri in tris:
                            if not all(v in vmap for v in tri):
                                continue
                            loop = SURef()
                            self.ok(self.dll.SULoopInputCreate(ctypes.byref(loop)))
                            for v in tri:
                                self.ok(self.dll.SULoopInputAddVertexIndex(loop, ctypes.c_size_t(vmap[v])))
                            fref = SURef()
                            r = self.dll.SUGeometryInputAddFace(gi, ctypes.byref(loop), ctypes.byref(fref))
                            if r == SU_ERROR_NONE:
                                mk = face_mats.get((oi, fi))
                                mat = materials.get(mk) or materials.get(f"mat_{obj['name']}")
                                if mat:
                                    mi = SUMaterialInput()
                                    mi.num_uv_coords = 0
                                    mi.material = mat
                                    self.dll.SUGeometryInputFaceSetFrontMaterial(gi, ctypes.c_size_t(fc), ctypes.byref(mi))
                                fc += 1
                    except:
                        pass

                if fc > 0:
                    grp = SURef()
                    self.ok(self.dll.SUGroupCreate(ctypes.byref(grp)))
                    self.dll.SUGroupSetName(grp, obj["name"].encode("utf-8"))
                    ge = SURef()
                    self.ok(self.dll.SUGroupGetEntities(grp, ctypes.byref(ge)))
                    self.ok(self.dll.SUEntitiesFill(ge, gi, True))
                    self.ok(self.dll.SUEntitiesAddGroup(ents, grp))

                self.dll.SUGeometryInputRelease(ctypes.byref(gi))

            # Save to temp file
            tmp = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".skp", delete=False) as tf:
                    tmp = tf.name
                path = tmp.encode("utf-8")
                if version and version in SU_MODEL_VERSION:
                    self.ok(self.dll.SUModelSaveToFileWithVersion(model, path, SU_MODEL_VERSION[version]))
                else:
                    self.ok(self.dll.SUModelSaveToFile(model, path))

                self.dll.SUModelRelease(ctypes.byref(model))

                with open(tmp, "rb") as f:
                    data = f.read()
                return data
            finally:
                if tmp and os.path.exists(tmp):
                    os.unlink(tmp)

        finally:
            self.dll.SUTerminate()

    def _parse_obj(self, text):
        vertices, objects, colors, face_mats = [], [], {}, {}
        cur = {"name": "default", "faces": []}
        cur_mtl = None
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            if line.startswith("#!color "):
                p = line.split()
                if len(p) >= 5:
                    colors[p[1]] = (int(p[2]), int(p[3]), int(p[4]))
                continue
            if line.startswith("#"):
                continue
            parts = line.split()
            kw = parts[0]
            if kw == "v" and len(parts) >= 4:
                vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
            elif kw == "f":
                face = []
                for p in parts[1:]:
                    vi = int(p.split("/")[0])
                    if vi < 0:
                        vi = len(vertices) + vi + 1
                    face.append(vi)
                if len(face) >= 3:
                    cur["faces"].append(face)
                    if cur_mtl:
                        face_mats[(len(objects), len(cur["faces"]) - 1)] = cur_mtl
            elif kw in ("o", "g"):
                if cur["faces"]:
                    objects.append(cur)
                cur = {"name": " ".join(parts[1:]) if len(parts) > 1 else f"obj_{len(objects)}", "faces": []}
            elif kw == "usemtl":
                cur_mtl = " ".join(parts[1:])
            elif kw == "mtllib":
                pass  # Colors are inline, no need for MTL
        if cur["faces"]:
            objects.append(cur)
        return vertices, objects, colors, face_mats


# ─── HTTP Server ──────────────────────────────────────────────────────────────

skp_api = None  # Lazy init

def get_api():
    global skp_api
    if skp_api is None:
        info = find_sketchup_dll()
        if not info:
            return None
        print(f"  SketchUp: {info[0]}")
        skp_api = SketchUpAPI(info[1])
    return skp_api


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        # API endpoint
        if self.path == "/api/status":
            info = find_sketchup_dll()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "skp": bool(info),
                "sketchup": info[0] if info else None,
                "versions": list(SU_MODEL_VERSION.keys()),
            }).encode())
            return

        # Serve static files
        path = unquote(self.path.split("?")[0])
        if path == "/":
            path = "/index.html"

        filepath = os.path.realpath(os.path.join(WEB_DIR, path.lstrip("/")))
        web_root = os.path.realpath(WEB_DIR)
        if not filepath.startswith(web_root + os.sep) and filepath != web_root:
            self.send_response(403)
            self.end_headers()
            return
        if os.path.isfile(filepath):
            mime = mimetypes.guess_type(filepath)[0] or "application/octet-stream"
            with open(filepath, "rb") as f:
                data = f.read()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path.startswith("/api/convert"):
            MAX_BODY = 100 * 1024 * 1024  # 100 MB
            length = min(int(self.headers.get("Content-Length", 0)), MAX_BODY)
            obj_data = self.rfile.read(length).decode("utf-8", errors="replace")
            version = self.headers.get("X-SKP-Version")

            api = get_api()
            if not api:
                self.send_response(500)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "SketchUp niet gevonden op deze PC"}).encode())
                return

            try:
                skp_data = api.convert_obj_to_skp(obj_data, version)
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition", "attachment; filename=model.skp")
                self.send_header("Content-Length", str(len(skp_data)))
                self.end_headers()
                self.wfile.write(skp_data)
                print(f"    SKP: {len(skp_data):,} bytes")
            except Exception as e:
                print(f"    FOUT: {e}")
                self.send_response(500)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Conversie mislukt"}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", f"http://localhost:{PORT}")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-SKP-Version")

    def log_message(self, fmt, *args):
        print(f"  {args[0]}")


def main():
    port = PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except:
            pass

    if not os.path.isdir(WEB_DIR):
        print(f"FOUT: Web directory niet gevonden: {WEB_DIR}")
        print("Zorg dat index.html en app.js in de 'web' submap staan.")
        sys.exit(1)

    info = find_sketchup_dll()
    print("=" * 50)
    print("  3D Converter + SKP Export")
    print("=" * 50)
    if info:
        print(f"  SketchUp: {info[0]}")
        print(f"  DLL:      {info[1]}")
    else:
        print("  SketchUp: NIET GEVONDEN")
        print("")
        print("  Gezocht in:")
        pf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
        pf86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
        print(f"    {pf}\\SketchUp\\*\\SketchUp\\SketchUpAPI.dll")
        print(f"    {pf}\\SketchUp*\\SketchUp\\SketchUpAPI.dll")
        print(f"    {pf86}\\SketchUp*\\SketchUp\\SketchUpAPI.dll")
        print("")
        print("  SKP export is uitgeschakeld.")
        print("  Andere formats (OBJ, STL, DXF, GLB) werken gewoon.")
    print(f"\n  Server:   http://localhost:{port}")
    print(f"  Stop:     Ctrl+C of sluit dit venster")
    print("=" * 50)

    import threading
    server = HTTPServer(("127.0.0.1", port), Handler)

    # Open browser zodra server draait
    def open_browser():
        import time
        time.sleep(0.5)
        webbrowser.open(f"http://localhost:{port}")

    threading.Thread(target=open_browser, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nGestopt.")


if __name__ == "__main__":
    main()
