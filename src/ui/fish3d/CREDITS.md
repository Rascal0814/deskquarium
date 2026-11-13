# 鱼的 3D 模型来源

这里的 .glb 是从 Sketchfab 下载的模型打包来的（`node scripts/pack-model.mjs <scene.gltf> <输出.glb>`：
把 scene.gltf、scene.bin 和贴图合成一个文件，老的材质写法顺手改成通用的），模型本身没有改动。
作者和授权也原样留在每个 .glb 的 asset.extras 里。

| 文件 | 模型 | 作者 | 授权 |
|---|---|---|---|
| neon.glb | [Paracheirodon Innesi _ Tetra Neon](https://sketchfab.com/3d-models/paracheirodon-innesi---tetra-neon-2fabf5db754746b7b81ebfa0bbe99161) | BlueMesh (VapTor) | CC BY 4.0 |

CC BY 的要求是署名：把这个项目分享出去时，这张表要跟着走。

往这里加模型之前先看授权：CC0、CC BY 这类可以随代码一起公开；
Sketchfab Standard 只允许在作品里使用，不允许把模型文件本身再分发，不能放进公开的仓库。

每个模型怎么摆正、体长怎么算、用哪段动画，写在 `../fish3d.mjs` 的 MODELS 里。
