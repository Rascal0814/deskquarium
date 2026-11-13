// 鱼的 3D 图层：用 three.js 把带贴图的鱼模型画到一张透明的 WebGL 画布上，
// render.mjs 每帧把这张画布贴进 2D 画面（背景、气泡、天气还是 2D 画的）。
// 为什么要 3D：图片（不管是画的还是照片）光是死的、只有一个姿势、掉头像翻纸片，放进鱼缸一眼就是贴纸；
// 模型受场景的光、身体左右摆、掉头是真的转过来。
// 模型文件在 fish3d/ 下，每种鱼一个 .glb（用 scripts/pack-model.mjs 从下载的模型打包），来源和授权见 fish3d/CREDITS.md。
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const QUARTER = Math.PI / 2

// 哪些鱼种有模型。
//   rot：把模型摆成「头朝 +x、背朝 +y」要转的角度（各家模型的朝向不一样，看一眼渲染结果就知道该填什么）
//   bodyFrac：体长占模型全长（含尾鳍）的比例——别处说的「体长」不含尾鳍
//   clip：用哪段骨骼动画（不填用第一段）；模型没带动画的由着色器让身体摆
//   tones：花色（genome.base）→ 整体压一层什么颜色，比如 { silver: '#c9d3d6', black: '#55555e' }。
//     一个模型只有一套贴图，花色只能靠色调区分；没列出来的花色用原样。红绿灯只有一种花色，用不上
const MODELS = {
  neon: { file: 'neon.glb', rot: [0, QUARTER, 0], bodyFrac: 0.9 },
}

// 没带骨骼动画的模型：在顶点着色器里让身体左右弯（《ABZÛ》的做法）。
// 模型已经摆正、全长缩成 1：头尖在 x = uHead。
function addSwimShader(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uPhase; uniform float uAmp; uniform float uHead;
        // u：0 头，1 尾。返回这一处往侧面偏多少，以及偏转的斜率。
        vec2 swimWave(float u) {
          float m = smoothstep(0.15, 1.0, u);          // 前半身几乎不动，越往尾巴摆得越大
          float a = uAmp * (0.25 + 0.75 * m * m);
          float ph = uPhase - u * 3.6;
          return vec2(a * sin(ph), -a * 3.6 * cos(ph));
        }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        {
          float slope = swimWave(clamp(uHead - position.x, 0.0, 1.0)).y;
          float c = inversesqrt(1.0 + slope * slope);
          float s = slope * c;
          objectNormal = vec3(objectNormal.x * c + objectNormal.z * s, objectNormal.y, objectNormal.z * c - objectNormal.x * s);
        }`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec2 w = swimWave(clamp(uHead - position.x, 0.0, 1.0));
          float pivot = uAmp * 0.6 * sin(uPhase + 0.9) * (position.x - (uHead - 0.4)); // 整条鱼跟着轻轻摆头
          transformed.z += w.x + pivot;
        }`,
      )
  }
}

function createFishLayer() {
  const canvas = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true })
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.85 // 白色的鱼在强光下容易白成一片，压一点
  const scene = new THREE.Scene()
  // 反光要有东西可反：一间柔光的「屋子」，鳞片的光泽才出得来。
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 0.55
  const sky = new THREE.HemisphereLight(0xffffff, 0x1b3a4a, 1.1) // 上面亮、肚子底下是水的暗色
  const sun = new THREE.DirectionalLight(0xfff4dc, 2.2)
  sun.position.set(-0.35, 1, 0.55) // 从上面偏前方照下来
  scene.add(sky, sun, sun.target)
  // 正交镜头：一个单位就是一个 CSS 像素，y 往下是负的。前后留得很深，鱼按大小排在不同的远近上（见 render）。
  const camera = new THREE.OrthographicCamera(0, 1, 0, -1, -40000, 40000)
  let W = 1
  let H = 1
  let ratio = 1

  const models = new Map() // species → { root, clips, skinned, cfg, tall }
  const fishes = new Map() // id → 画面上的一条
  const loader = new GLTFLoader()

  // 解析 glb。模型里内嵌的贴图 GLTFLoader 默认用 fetch 去读（blob 地址），页面的安全策略不放行；
  // 解析开始的那一下把 createImageBitmap 藏起来，它就改用 <img> 读，策略是放行的。
  function parse(buffer) {
    return new Promise((resolve, reject) => {
      const keep = self.createImageBitmap
      self.createImageBitmap = undefined
      try {
        loader.parse(buffer, '', resolve, reject)
      } finally {
        self.createImageBitmap = keep
      }
    })
  }

  // 启动时调一次。read(文件名) 返回这个模型文件的字节。
  // 哪个模型读不出来就跳过（那种鱼退回用贴图画），不让整个鱼缸起不来。
  async function loadAll(read) {
    await Promise.all(
      Object.entries(MODELS).map(async ([species, cfg]) => {
        try {
          const bytes = await read(cfg.file)
          if (!bytes) throw new Error('文件读不到')
          const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          prepare(species, await parse(buffer), cfg)
        } catch (e) {
          console.error(`[fish3d] ${cfg.file} 读不出来，${species} 退回用贴图画：`, e)
        }
      }),
    )
  }

  // 把模型摆正（头朝 +x、背朝 +y）、挪到中心、全长缩成 1，以后每条鱼只要再整体放大到它的长度。
  function prepare(species, gltf, cfg) {
    const turn = new THREE.Group()
    turn.rotation.set(...(cfg.rot ?? [0, 0, 0]))
    turn.add(gltf.scene)
    let root = new THREE.Group()
    root.add(turn)
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3())
    const centre = box.getCenter(new THREE.Vector3())
    const k = 1 / size.x
    turn.scale.setScalar(k)
    turn.position.copy(centre).multiplyScalar(-k)
    root.updateMatrixWorld(true)
    let skinned = false
    root.traverse((o) => {
      if (o.isSkinnedMesh) skinned = true
      if (!o.isMesh) return
      o.frustumCulled = false // 顶点会被骨骼 / 着色器挪动，包围盒不准
      // 鳍是半透明的，所以作者把整条鱼都标成了「半透明」；半透明的东西默认不记远近，
      // 嘴里、鳃里的面会透到外面来（嘴边一道黑线）。让带贴图的材质照常记远近，全透明的像素直接丢掉。
      if (o.material.transparent && o.material.map) {
        o.material.depthWrite = true
        o.material.alphaTest = 0.03
      }
    })
    if (!skinned) {
      // 没骨骼：把摆正、缩放都烤进顶点里，着色器里的坐标就是「头朝 +x、全长 1」。
      const flat = new THREE.Group()
      root.traverse((o) => {
        if (!o.isMesh) return
        const mesh = new THREE.Mesh(o.geometry.clone().applyMatrix4(o.matrixWorld), o.material)
        mesh.geometry.computeVertexNormals()
        mesh.frustumCulled = false
        flat.add(mesh)
      })
      root = flat
    }
    models.set(species, { root, clips: gltf.animations, skinned, cfg, tall: size.y * k })
  }

  const has = (species) => models.has(species)

  function instance(species) {
    const m = models.get(species)
    const node = new THREE.Group()
    const uniforms = { uPhase: { value: 0 }, uAmp: { value: 0.05 }, uHead: { value: 0.5 } }
    const body = m.skinned ? SkeletonUtils.clone(m.root) : m.root.clone()
    const paints = [] // 每条鱼自己的一份材质：花色、病态的灰都是往材质上调颜色
    body.traverse((o) => {
      if (!o.isMesh) return
      o.material = o.material.clone()
      if (!m.skinned) addSwimShader(o.material, uniforms)
      paints.push({ material: o.material, base: o.material.color.clone() })
    })
    let mixer = null
    if (m.skinned && m.clips.length > 0) {
      mixer = new THREE.AnimationMixer(body)
      mixer.clipAction(m.clips.find((c) => c.name === m.cfg.clip) ?? m.clips[0]).play()
      mixer.update(Math.random() * 4) // 各条鱼从动画的不同位置开始，不会齐步摆尾
    }
    node.add(body)
    scene.add(node)
    return { species, node, mixer, uniforms, paints, look: null, bodyFrac: m.cfg.bodyFrac ?? 0.85, tones: m.cfg.tones ?? {} }
  }

  function drop(it) {
    scene.remove(it.node)
    for (const p of it.paints) p.material.dispose()
  }

  const tmp = new THREE.Color()
  const GREY = new THREE.Color('#aab0ad')
  function paint(it, tone, fade) {
    const look = `${tone}|${fade}`
    if (it.look === look) return
    it.look = look
    for (const p of it.paints) {
      p.material.color.copy(p.base)
      if (it.tones[tone]) p.material.color.multiply(tmp.set(it.tones[tone]))
      if (fade > 0) p.material.color.lerp(GREY, fade)
    }
  }

  // w, h：画面的 CSS 尺寸；scale：一个 CSS 像素画成几个实际像素（和 2D 画布一致）。
  function setSize(w, h, scale) {
    W = w
    H = h
    ratio = scale
    renderer.setPixelRatio(scale)
    renderer.setSize(w, h, false)
    camera.right = w
    camera.bottom = -h
    camera.updateProjectionMatrix()
  }

  // 画一帧。list 里每条鱼：
  //   { id, species, x, y, lenPx（体长）, yaw（0 朝右，-π 朝左，中间是转身、-π/2 正对着人）, pitch（正的低头）,
  //     phase / effort / dt（游动：没骨骼的看 phase，有骨骼的按 dt 往前放动画，越用力放得越快）,
  //     tone（花色）, fade（0 正常，越大越灰）, dead }
  // 顺序就是远近：排在后面的在前面。
  // light：{ level（0 暗 ~ 1 亮）, tint（背景的平均颜色 [r, g, b]，0~1——鱼身上的光往背景的色调上靠） }
  const WARM = new THREE.Color(0xfff4dc)
  const WHITE = new THREE.Color(0xffffff)
  function render(list, light = {}) {
    const seen = new Set()
    list.forEach((f, i) => {
      if (!models.has(f.species)) return
      seen.add(f.id)
      let it = fishes.get(f.id)
      if (!it || it.species !== f.species) {
        if (it) drop(it)
        it = instance(f.species)
        fishes.set(f.id, it)
      }
      const total = f.lenPx / it.bodyFrac
      it.node.position.set(f.x, -f.y, (i - list.length) * 900) // 鱼和鱼隔开得比鱼身厚，叠在一起时不会互相穿进去
      it.node.scale.setScalar(total)
      it.node.rotation.set(0, 0, 0)
      it.node.rotateY(f.yaw ?? 0)
      it.node.rotateZ(-(f.pitch ?? 0))
      if (f.dead) it.node.rotateX(Math.PI) // 死鱼肚皮朝上
      const effort = clamp(f.effort ?? 0.3, 0, 1)
      it.uniforms.uPhase.value = f.phase ?? 0
      it.uniforms.uAmp.value = f.dead ? 0 : 0.02 + 0.05 * effort
      if (it.mixer && !f.dead) it.mixer.update((f.dt ?? 0) * (0.45 + 1.6 * effort))
      paint(it, f.tone, f.fade ?? 0)
    })
    for (const [id, it] of fishes) {
      if (!seen.has(id)) {
        drop(it)
        fishes.delete(id)
      }
    }
    const level = light.level ?? 1
    sun.intensity = 1.9 * level
    sky.intensity = 0.4 + 0.7 * level
    if (light.tint) {
      // 背景的平均色调成最亮的通道 = 1（只取色调，不取明暗），光往它上面靠一些。
      const top = Math.max(light.tint[0], light.tint[1], light.tint[2], 0.01)
      tmp.setRGB(light.tint[0] / top, light.tint[1] / top, light.tint[2] / top, THREE.SRGBColorSpace)
      sun.color.copy(WARM).lerp(tmp, 0.4)
      sky.color.copy(WHITE).lerp(tmp, 0.55)
    }
    renderer.render(scene, camera)
  }

  const count = () => fishes.size

  // 选鱼界面用：把这种鱼单独画一条到 2D 画布上（k 是那张画布的 context，w、h 是它的 CSS 尺寸）。
  function preview(species, k, w, h, dpr) {
    const m = models.get(species)
    const keep = [W, H, ratio]
    setSize(w, h, dpr)
    const total = Math.min(w, h / m.tall) * 0.9
    render([{ id: '#preview', species, x: w / 2, y: h / 2, lenPx: total * (m.cfg.bodyFrac ?? 0.85), yaw: 0, effort: 0.3, dt: 0 }])
    k.drawImage(canvas, 0, 0, w, h)
    setSize(...keep)
  }

  return { canvas, loadAll, has, setSize, render, count, preview }
}

// 整个页面共用一个（一个 WebGL 画布）。第一次用到时才建。
let layer = null
export function fishLayer() {
  layer ??= createFishLayer()
  return layer
}
