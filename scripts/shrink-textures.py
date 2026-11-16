# 下载来的模型贴图太大（比如四张 4096，合起来六七十 MB）时，打包前先缩小。
# 用法：python scripts/shrink-textures.py models/<名字> 2048        （要先 pip install pillow）
# 颜色贴图缩到给定的边长，法线、粗糙度再小一半；带透明的存 PNG，其余存 JPEG。
# 小贴图写到 models/<名字>/textures-small/，另存一份指向它们的 scene.small.gltf，拿这个文件去打包：
#   node scripts/pack-model.mjs models/<名字>/scene.small.gltf src/ui/fish3d/<鱼种>.glb
import json, os, sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
src, side = sys.argv[1], int(sys.argv[2])
g = json.load(open(os.path.join(src, 'scene.gltf'), encoding='utf-8'))
os.makedirs(os.path.join(src, 'textures-small'), exist_ok=True)
for img in g['images']:
    im = Image.open(os.path.join(src, img['uri']))
    alpha = im.mode == 'RGBA' and im.getchannel('A').getextrema()[0] < 255
    s = side if alpha else side // 2  # 颜色贴图留大的，法线和粗糙度小一半看不出来
    im = im.resize((s, s), Image.LANCZOS)
    name = os.path.splitext(os.path.basename(img['uri']))[0]
    if alpha:
        out = f'textures-small/{name}.png'
        im.save(os.path.join(src, out), optimize=True)
    else:
        out = f'textures-small/{name}.jpg'
        im.convert('RGB').save(os.path.join(src, out), quality=90, subsampling=0)
    print(img['uri'], '->', out, os.path.getsize(os.path.join(src, out)) >> 10, 'KB')
    img['uri'] = out
json.dump(g, open(os.path.join(src, 'scene.small.gltf'), 'w', encoding='utf-8'))
