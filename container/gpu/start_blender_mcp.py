"""
Blender startup script — enables the blender-mcp addon, starts the socket
server, and saves a baseline scene.blend.

This file is BAKED INTO the Docker image (container/gpu/start_blender_mcp.py).
The onstart script launches Blender with --python /root/start_blender_mcp.py.
"""
import bpy
import os
import sys

port = int(os.environ.get("BLENDER_PORT", "9876"))

try:
    # Enable the addon via Blender's preferences system.
    bpy.utils.refresh_script_paths()
    try:
        bpy.ops.preferences.addon_enable(module="blender_mcp")
        print(f"blender-mcp: addon enabled via preferences", flush=True)
    except Exception as e:
        print(f"blender-mcp: addon_enable failed: {e}", flush=True)

    # Start the socket server via the addon's operator.
    try:
        bpy.ops.blender_mcp.start_server()  # type: ignore[attr-defined]
        print(f"blender-mcp: server started via operator on port {port}", flush=True)
    except Exception as e:
        print(f"blender-mcp: operator start_server failed: {e}", flush=True)
        # Fallback: import the module directly and call its functions
        try:
            import blender_mcp
            for fn_name in ("start_server", "run_server", "start_mcp_server"):
                fn = getattr(blender_mcp, fn_name, None)
                if callable(fn):
                    try:
                        fn(host="0.0.0.0", port=port)
                        print(f"blender-mcp: server started via {fn_name}", flush=True)
                        break
                    except TypeError:
                        fn(port)
                        print(f"blender-mcp: server started via {fn_name}(port)", flush=True)
                        break
        except Exception as e2:
            print(f"blender-mcp: FATAL - could not start server: {e2}", flush=True)

    # Persist a baseline scene.blend so the host's periodic syncDown always
    # finds a file (even on a fresh instance before the agent makes changes).
    try:
        bpy.ops.wm.save_as_mainfile(filepath="/root/blender/scene.blend")
        print("blender-mcp: saved baseline scene.blend", flush=True)
    except Exception as e:
        print(f"blender-mcp: WARN could not save baseline scene.blend: {e}", flush=True)
except Exception as e:
    import traceback
    traceback.print_exc()
    print(f"blender-mcp: FATAL - {e}", flush=True)
