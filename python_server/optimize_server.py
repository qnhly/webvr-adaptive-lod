from flask import Flask, request, jsonify
from flask_cors import CORS
import joblib
import numpy as np
import heapq
import json
from scipy.optimize import linprog
import ssl
# ─────────────────────────────────────────────
#  Branch-and-Bound solver (faces + VRAM budget)
# ─────────────────────────────────────────────
class BnB_LOD:
    def __init__(self, QoE, faces, vram, budget, vram_budget):
        self.QoE = np.array(QoE)
        self.faces = np.array(faces)
        self.vram = np.array(vram)

        self.B = budget
        self.gpuB = vram_budget

        self.N, self.M = self.QoE.shape
        self.num_vars = self.N * self.M

        self.best_value = -np.inf
        self.best_solution = None

    def _build_lp(self, fixed_vars):
        
        c = -self.QoE.flatten()

        A_ub = [self.faces.flatten()]
        b_ub = [self.B]

        # Add VRAM constraint
        if self.gpuB is not None:
            A_ub.append(self.vram.flatten())
            b_ub.append(self.gpuB)

        A_eq = []
        b_eq = []
        for n in range(self.N):
            row = np.zeros(self.num_vars)
            for m in range(self.M):
                row[n * self.M + m] = 1
            A_eq.append(row)
            b_eq.append(1)

        bounds = [(0, 1)] * self.num_vars
        bounds = list(bounds)
        for idx, val in fixed_vars.items():
            bounds[idx] = (val, val)

        return c, A_ub, b_ub, A_eq, b_eq, bounds

    def solve(self):
       
        Q = []
        counter = 0
        heapq.heappush(Q, (-np.inf, counter, {}))

        while Q:
            _, _, fixed_vars = heapq.heappop(Q)
            c, A_ub, b_ub, A_eq, b_eq, bounds = self._build_lp(fixed_vars)
            res = linprog(c, A_ub=A_ub, b_ub=b_ub, A_eq=A_eq, b_eq=b_eq,
                          bounds=bounds, method='highs')

            if not res.success:
                continue

            zLP = -res.fun
            xLP = res.x

            if zLP <= self.best_value:
                continue

            if np.all(np.isclose(xLP, np.round(xLP))):
                if zLP > self.best_value:
                    self.best_value = zLP
                    self.best_solution = np.round(xLP)
                continue

            branch_var = None
            for i in range(len(xLP)):
                if not np.isclose(xLP[i], np.round(xLP[i])):
                    branch_var = i
                    break

            fixed0 = fixed_vars.copy()
            fixed0[branch_var] = 0
            fixed1 = fixed_vars.copy()
            fixed1[branch_var] = 1

            counter += 1
            heapq.heappush(Q, (-zLP, counter, fixed0))
            counter += 1
            heapq.heappush(Q, (-zLP, counter, fixed1))

        if self.best_solution is None:
            return None, -np.inf

        return self.best_solution.reshape(self.N, self.M), self.best_value

# ─────────────────────────────────────────────
#  Flask app
# ─────────────────────────────────────────────
# Flask server
app = Flask(__name__)
CORS(app)

# Load RF model
rf_model = joblib.load("./python_server/rf_model.pkl")

# Load models config từ JSON
with open('./server_assets/models_config.json', 'r') as f:
    config = json.load(f)

models = config['models']
N = len(models)
L = len(models[0]['lods'])
faces  = np.array([[lod['faces'] for lod in m['lods']] for m in models])
vram   = np.array([[lod.get('gpusize', 0) for lod in m['lods']] for m in models])
lod    = np.array([lod['ratio'] for lod in models[0]['lods']])  # [80,60,50,40,30,20,10,5]
s_geo  = np.array([m['s_geo'] for m in models])
s_col  = np.array([m['s_col'] for m in models])


@app.route("/optimize", methods=["POST"])
def optimize():
    data = request.json
    distances = np.array(data["distance"]).reshape(-1)
    budget = data["budget"]
    vram_budget = data.get("vram_budget", None)

    N, L = faces.shape

    # Predict QoE
    QoE_matrix = np.zeros((N, L))
    for i in range(N):
        for j in range(L):
            X = np.array([[lod[j], distances[i], faces[i][j], s_geo[i], s_col[i]]])
            QoE_matrix[i][j] = rf_model.predict(X)[0]

    # print("Distance:", distances)

    
    solver = BnB_LOD(QoE_matrix, faces, vram, budget, vram_budget)
    best_solution, best_value = solver.solve()
    if best_solution is None:
        return jsonify({"error": "BnB infeasible — check budget constraints"}), 500

    chosen_lods = [row.tolist().index(1) for row in best_solution]
    print("[proposed] " + " | ".join(f"M{i+1}: LOD{idx+1}" for i, idx in enumerate(chosen_lods)))
    print(f"[proposed] Total QoE: {best_value:.4f}")

    # Prepare response
    result = []
    try:
        for i, lod_idx in enumerate(chosen_lods):
            result.append({
                "model_id": models[i]['id'],
                "lod_index": lod_idx,
                "url": models[i]['lods'][lod_idx]['url']
            })
        print(f"Result prepared: {result}")
    except Exception as e:
        print(f"Error building result: {e}")
        return jsonify({
            "error": str(e),
            "best_value": best_value,
            "best_solution": best_solution.tolist()
        }), 500

    return jsonify({
        "best_value": best_value,
        "result": result,
        "best_solution": best_solution.tolist()
    })


if __name__ == "__main__":
   
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain('live_server.cert.pem', 'live_server.key.pem')
    app.run(host='0.0.0.0', port=5000, debug=True, ssl_context=ctx)