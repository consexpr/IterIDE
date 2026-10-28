import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const build = new URL('../build/', import.meta.url)
const svg = await readFile(new URL('../src/shared/branding/iter-icon.svg', import.meta.url), 'utf8')
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map((size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())
await mkdir(build, { recursive: true })
await writeFile(new URL('icon.svg', build), svg)
await writeFile(new URL('icon.png', build), images.at(-1))
await writeFile(new URL('icon.ico', build), await pngToIco(images))
console.log(`Generated ${fileURLToPath(new URL('icon.png', build))} (256px) and icon.ico (${sizes.join(', ')}px)`)
