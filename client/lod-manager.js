const BUDGET = 1000000;
const VRAM_BUDGET = 3000; // MB
const num_model = 8;
const num_lod = 8;
let lastQoeValue = 0; 

// Server IP configuration
var ip = 'https://xx.xx.xx.xx';

let addr = "../server_assets/";
const currentLods = new Array(num_model).fill(7);
var lastDist = null;
let modelsConfig = null; // Load từ JSON

// cache loaded entities: key = "M1-lod7" → entity
const preloadedEntities = {};

// store initial transforms of models (from HTML) for later use
const modelInitialTransform = [];

// Load models config từ JSON
async function loadModelsConfig() {
  try {
    const response = await fetch('./models_config.json');
    modelsConfig = await response.json();
    console.log("Models config loaded:", modelsConfig.models.length, "models");
  } catch (err) {
    console.error("Failed to load models_config.json:", err);
  }
}

// Capture initial transforms of models from HTML and store in modelInitialTransform
function captureModelInitialTransforms() {
  for (let i = 0; i < num_model; i++) {
    const modelEl = document.querySelector(`#model${i}`);
    if (modelEl) {
      modelInitialTransform[i] = {
        position: modelEl.getAttribute('position'),
        rotation: modelEl.getAttribute('rotation'),
        scale: modelEl.getAttribute('scale')
      };
      console.log(`Model ${i} initial transform:`, modelInitialTransform[i]);
      
      // "Adopt" the initial LOD entity into preloadedEntities
      const initialLod = currentLods[i]; 
      const key = `M${i+1}-lod${initialLod}`;
      preloadedEntities[key] = modelEl;
      console.log(`Registered initial entity:`, key);

      // Hide the initial entity for now; it will be shown later in distance-check
      modelEl.setAttribute('visible', false);
    }
  }
}


function getOrCreateLodEntity(objIdx, lodIndex, url, position, rotation, scale) {
  const key = `M${objIdx+1}-lod${lodIndex}`;

  if (preloadedEntities[key]) return Promise.resolve(preloadedEntities[key]);

  return new Promise((resolve) => {
    const assetId = `asset-${key}`;
    let assetEl = document.getElementById(assetId);
    if (!assetEl) {
      assetEl = document.createElement('a-asset-item');
      assetEl.setAttribute('id', assetId);
      assetEl.setAttribute('src', addr + url);
      document.querySelector('a-assets').appendChild(assetEl);
    }

    const entityEl = document.createElement('a-entity');
    entityEl.setAttribute('id', key);
    entityEl.setAttribute('gltf-model', `#${assetId}`);
    entityEl.setAttribute('animation-mixer', '');
    entityEl.setAttribute('visible', false);
    if (position) entityEl.setAttribute('position', position);
    if (rotation) entityEl.setAttribute('rotation', rotation);
    if (scale)    entityEl.setAttribute('scale', scale);

    preloadedEntities[key] = entityEl;

    document.querySelector('a-scene').appendChild(entityEl);

    entityEl.addEventListener('model-loaded', () => {
      resolve(entityEl);
    }, { once: true });
  });
}

function switchLod(objIdx, chosenLod, url) {
  if (currentLods[objIdx] === chosenLod) return;

  const initialTransform = modelInitialTransform[objIdx];
  if (!initialTransform) {
    console.error(`No initial transform for model ${objIdx}`);
    return;
  }

  const position = initialTransform.position;
  const rotation = initialTransform.rotation;
  const scale = initialTransform.scale;

  const currentKey = `M${objIdx+1}-lod${currentLods[objIdx]}`;
  const currentEl = preloadedEntities[currentKey];

  let savedTime = 0;
  if (currentEl) {
    const mixer = currentEl.components['animation-mixer'];
    if (mixer && mixer.mixer && mixer.mixer._actions[0]) {
      savedTime = mixer.mixer._actions[0].time;
    }
  }

  getOrCreateLodEntity(objIdx, chosenLod, url, position, rotation, scale)
    .then(newEl => {
      //hide entity + pause animation
      if (currentEl) {
        currentEl.setAttribute('visible', false);
        const oldMixer = currentEl.components['animation-mixer'];
        if (oldMixer && oldMixer.mixer) {
          oldMixer.mixer._actions.forEach(a => a.paused = true);
        }
      }

      // Show new entity + sync animation
      newEl.setAttribute('visible', true);
      const newMixer = newEl.components['animation-mixer'];
      if (newMixer && newMixer.mixer && newMixer.mixer._actions[0]) {
        const action = newMixer.mixer._actions[0];
        action.time = savedTime % action.getClip().duration;
        action.paused = false;
        newMixer.mixer.update(0);
      }

      currentLods[objIdx] = chosenLod;
      saveLodSnapshot();

      const now = new Date().toLocaleTimeString('vi-VN');
      const lodInfo = currentLods.map((lod, i) => `M${i+1}: ${lod+1}`).join(' | ');
      console.log(`[${now}] Current LODs: ${lodInfo}`);
    });
}

// ---- Distance Check + Server Communication ----
AFRAME.registerComponent('distance-check', {

  init: function () {
    this.cam = document.querySelector('#head');
    this.model = [];
    for (let i = 0; i < num_model; i++) {
      this.model.push(document.querySelector(`#model${i}`));
    }
    this.camWorld = new THREE.Vector3();
    this.modelWorld = new THREE.Vector3();
    this.ready = false;
    this.sending = false;
    
    // Load models config + capture initial transforms
    loadModelsConfig();
    captureModelInitialTransforms();
    
    //initialize scene: show default LODs
  const scene = document.querySelector('a-scene');
  const showDefault = () => {
    for (let i = 0; i < num_model; i++) {
      const key = `M${i+1}-lod${currentLods[i]}`;
      const el = preloadedEntities[key];
      if (el) el.setAttribute('visible', true);
    }
  };

  if (scene.hasLoaded) {
    showDefault();
  } else {
    scene.addEventListener('loaded', showDefault, { once: true });
  }

    setTimeout(() => {
      console.log("Ready to send data to server...");
      this.ready = true;
    }, 8000);
  },

  tick: function (time, delta) {
    if (!this.cam || !this.model || !this.ready) return;

    this.cam.object3D.getWorldPosition(this.camWorld);
    const dist = [];
    for (let i = 0; i < num_model; i++) {
      if (this.model[i]) {
        this.model[i].object3D.getWorldPosition(this.modelWorld);
        dist.push(this.camWorld.distanceTo(this.modelWorld));
      }
    }

    if (!this.lastSend || time - this.lastSend > 3500) {
      if (this.sending) return;

      const THRESHOLD = 0.5;
      const distChanged = lastDist === null || dist.some((d, i) => Math.abs(d - lastDist[i]) > THRESHOLD);
      if (!distChanged) {
        console.log("Distances unchanged, not sending to server.");
        return;
      }

      this.lastSend = time;
      this.sending = true;
      lastDist = [...dist];

      console.log("Sending to server...", dist);
      fetch(ip + ':5000/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ distance: [dist], budget: BUDGET, vram_budget: VRAM_BUDGET })
      })
      .then(res => res.json())
      .then(data => {
        console.log("Server response:", JSON.stringify(data));
        
        let result = data.result;

        lastQoeValue = data.best_value ?? 0; 
        
        // Fallback: if server returns best_solution instead of result
        if (!result && data.best_solution) {
          console.warn("Server returned best_solution, converting to result format...");
          result = data.best_solution.map((row, modelIdx) => {
            const lod_idx = row.indexOf(1); // find index of 1 in the row
            if (lod_idx === -1) {
              console.error(`No LOD selected for model ${modelIdx}`);
              return null;
            }
            
            // get url from modelsConfig if available
            let url = null;
            if (modelsConfig && modelsConfig.models[modelIdx]) {
              url = modelsConfig.models[modelIdx]['lods'][lod_idx]['url'];
            }
            
            return {
              model_id: `M${modelIdx+1}`,
              lod_index: lod_idx,
              url: url
            };
          }).filter(r => r !== null);
        }

        if (!result || !Array.isArray(result)) {
          console.error("Invalid server response. No result array found:", data);
          this.sending = false;
          return;
        }

        console.log("QoE:", data.best_value);

        // Process each LOD recommendation from server
        for (const item of result) {
          const objIdx = parseInt(item.model_id.replace('M', '')) - 1; // "M1" → 0
          const chosenLod = item.lod_index;
          const url = item.url;

          if (!url) {
            console.warn(`No URL for M${objIdx+1} LOD ${chosenLod+1}`);
            continue;
          }

          console.log(`Switching M${objIdx+1} to LOD ${chosenLod+1}, url: ${url}`);
          switchLod(objIdx, chosenLod, url);
        }
        this.sending = false;
      })
      .catch(err => {
        console.error(err);
        this.sending = false;
      });
    }
  }
});
