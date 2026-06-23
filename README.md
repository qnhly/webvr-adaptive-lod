# WebVR Adaptive LOD Streaming Framework



## Structure
- `python_server/` — Flask optimization server (BnB + QoE prediction)
- `client/`       — A-Frame WebVR client
- `server_asset/` — 3D mesh assets (glTF/GLB) with LoD variants

## Run the Optimization Server

```bash
cd webvr-adaptive-lod
python python_server/optimize_server.py
```
