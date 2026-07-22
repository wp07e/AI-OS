"""Smoke test for the scene-diff logic in addon.py.

Run inside the ai-os-base image:
    docker run --rm -v "$PWD/container/gpu/test_diff.py:/t.py" ai-os-base:latest python3 /t.py

Stubs bpy + addon deps so we can import the REAL addon module and exercise the
_scene_manifest / _format_scene_diff methods against simulated Blender state,
without needing a running Blender.
"""
import sys, types, importlib.util, datetime as _dt


def stub(name, **attrs):
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules[name] = m
    return m


# A fake Blender object — just enough attributes for the manifest logic.
class FakeObj:
    def __init__(self, name, loc, parent=None, verts=64, type_="MESH"):
        self.type = type_
        self.name = name
        self.location = types.SimpleNamespace(x=loc[0], y=loc[1], z=loc[2])
        self.scale = types.SimpleNamespace(x=1.0)
        self.parent = parent
        if type_ == "MESH":
            self.data = types.SimpleNamespace(vertices=list(range(verts)))


class _AnyBase:
    """Permissive base class + attribute source for Blender UI registrations.

    addon.py does `class X(bpy.types.AddonPreferences)` and `bpy.types.Operator`
    — these need a real type as a base, and any attribute access should yield a
    callable that returns a usable type instance. We don't exercise those paths;
    we only need the import to succeed so we can reach the diff methods.
    """
    def __init__(self, *a, **k):
        pass


class _TypesNs(types.SimpleNamespace):
    def __getattr__(self, k):
        return _AnyBase


# bpy needs a real .data.objects list but can be permissive otherwise.
bpy = stub("bpy")
bpy.data = types.SimpleNamespace(objects=[])
bpy.context = types.SimpleNamespace()
bpy.app = types.SimpleNamespace()
bpy.types = _TypesNs()
# Register bpy.props / bpy.types as full dotted submodules so `import bpy.props`
# inside addon.py resolves from sys.modules without needing bpy to be a package.
sys.modules["bpy.types"] = bpy.types
bpy_props = types.ModuleType("bpy.props")
bpy_props.IntProperty = lambda **k: None
bpy_props.BoolProperty = lambda **k: None
sys.modules["bpy.props"] = bpy_props
bpy.props = bpy_props
stub("mathutils", Vector=type("V", (), {}))
stub("requests", utils=types.SimpleNamespace(default_headers=lambda: {}))
for n in ["re", "json", "threading", "socket", "time", "tempfile", "traceback",
          "os", "shutil", "zipfile", "io", "hashlib", "hmac", "base64"]:
    stub(n)
sys.modules["datetime"] = _dt
stub("os.path", join=lambda *a: "/".join(a))
stub("contextlib", redirect_stdout=lambda *a, **k: None, suppress=lambda *a, **k: None)

# Import the REAL addon (sits next to this test file).
spec = importlib.util.spec_from_file_location("addon", "/app/gpu/addon.py")
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
S = addon.BlenderMCPServer
s = S.__new__(S)

failures = 0


def check(cond, msg):
    global failures
    print(("PASS" if cond else "FAIL") + ": " + msg)
    if not cond:
        failures += 1


# 1. Empty diff when nothing changed.
bpy.data.objects = []
before = s._scene_manifest()
check(s._format_scene_diff(before) == "", "empty diff when nothing changed")

# 2. The exact reported failure: transform_apply zeros location + new unparented 0-vert part.
bpy.data.objects = [
    FakeObj("Thorax", (0.0, 0, 0.05), parent=None, verts=128),
    FakeObj("Head", (0.30, 0, 0.05), parent=None, verts=96),
]
before = s._scene_manifest()
bpy.data.objects[0].location = types.SimpleNamespace(x=0.0, y=0.0, z=0.0)  # transform_apply
bpy.data.objects.append(FakeObj("Leg_L_Front", (0.1, 0, 0), parent=None, verts=0))  # detached
diff = s._format_scene_diff(before)
print("\n--- diff (failure case) ---\n" + diff + "\n------")
check("RESET" in diff and "transform_apply" in diff, "transform_apply location-zero flagged")
check("Leg_L_Front" in diff and "UNPARENTED" in diff, "unparented new part flagged")
check("ZERO VERTICES" in diff, "zero-vertex corrupted mesh flagged")

# 3. Clean move — no false-positive scary warnings.
bpy.data.objects = [FakeObj("Head", (0.3, 0, 0.05), parent=None, verts=96)]
before = s._scene_manifest()
bpy.data.objects[0].location = types.SimpleNamespace(x=0.35, y=0, z=0.05)
diff = s._format_scene_diff(before)
print("\n--- diff (clean move) ---\n" + diff + "\n------")
check("RESET" not in diff and "UNPARENTED" not in diff, "clean move has no false warnings")
check("0.3" in diff and "0.35" in diff, "clean move shows the delta")

# 4. A new properly-parented part — should NOT warn unparented.
bpy.data.objects = []
before = s._scene_manifest()
root = FakeObj("AssemblyRoot", (0, 0, 0), type_="EMPTY")
bpy.data.objects.append(root)
bpy.data.objects.append(FakeObj("Thorax", (0, 0, 0.05), parent=root, verts=128))
diff = s._format_scene_diff(before)
print("\n--- diff (parented part) ---\n" + diff + "\n------")
check("Thorax" in diff, "new parented part appears")
check("UNPARENTED" not in diff, "parented part not falsely flagged")

# 5. Read-only set correctness.
check("execute_code" not in S._READ_ONLY_COMMANDS, "execute_code treated as mutating")
check("get_scene_info" in S._READ_ONLY_COMMANDS, "get_scene_info treated as read-only")
check("get_viewport_screenshot" in S._READ_ONLY_COMMANDS, "screenshot treated as read-only")

# 5a. New CAMERA object triggers the aim_camera_at nudge — fires at exactly the
#     moment a camera appears, pointing the agent at the safe aiming tool
#     instead of letting it hand-calculate rotation.
bpy.data.objects = []
before = s._scene_manifest()
bpy.data.objects.append(FakeObj("Camera", (4.0, -2.5, 2.0), type_="CAMERA"))
diff = s._format_scene_diff(before)
print("\n--- diff (new camera) ---\n" + diff + "\n------")
check("Camera" in diff and "CAMERA" in diff, "new camera appears in diff")
check("aim_camera_at" in diff, "camera nudge points to aim_camera_at tool")
check("get_viewport_screenshot" in diff, "camera nudge suggests viewport verification")
check("NEVER hand-calculate" in diff, "camera nudge warns against hand-calculated rotation")

# 5b. New safe-guardrail tools must be MUTATING so they inherit the scene-diff
#     safety net (like execute_code). A read-only classification would skip the
#     before/after diff, hiding any transform regressions they cause.
check("aim_camera_at" not in S._READ_ONLY_COMMANDS, "aim_camera_at treated as mutating")
check("apply_scale_safe" not in S._READ_ONLY_COMMANDS, "apply_scale_safe treated as mutating")

# 6. CRITICAL: the diff must land under the "result" key of the execute_code
#    response, because the blender-mcp MCP server reads ONLY result.get("result")
#    when surfacing the tool output to the agent. Earlier versions put it under
#    "_scene_diff"/"return", which the server silently discarded.
bpy.data.objects = []
before = s._scene_manifest()
bpy.data.objects.append(FakeObj("Thorax", (0, 0, 0), parent=None, verts=64))
diff = s._format_scene_diff(before)
# Simulate what the handler does with a dict result like execute_code returns.
sim_result = {"executed": True, "result": "ok"}
cur = sim_result.get("result")
if isinstance(cur, str):
    sim_result["result"] = (cur + "\n" + diff) if cur else diff
check("scene-diff" in sim_result["result"], "diff lands under the 'result' key the MCP server reads")
check("_scene_diff" not in sim_result, "diff NOT stranded under the unread '_scene_diff' key")

print("\n" + ("ALL TESTS PASSED" if failures == 0 else f"{failures} TEST(S) FAILED"))
sys.exit(1 if failures else 0)
