/** Content-Length counts UTF-8 bytes, not JS characters. */
export function frameMessage(message: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

export class LspMessageParser {
    private readonly header = Buffer.alloc(8192)
    private headerLength = 0
    private body?: Buffer
    private bodyLength = 0
    constructor(private readonly receive: (message: unknown) => void) {}

    push(chunk: Buffer): void {
        let offset = 0
        while (offset < chunk.length) {
            if (!this.body) {
                let complete = false
                while (offset < chunk.length) {
                    if (this.headerLength === this.header.length) {
                        this.reset()
                        return
                    }
                    this.header[this.headerLength++] = chunk[offset++]
                    const end = this.headerLength
                    if (
                        end >= 4 &&
                        this.header[end - 4] === 13 &&
                        this.header[end - 3] === 10 &&
                        this.header[end - 2] === 13 &&
                        this.header[end - 1] === 10
                    ) {
                        complete = true
                        break
                    }
                }
                if (!complete) return
                const header = this.header.subarray(0, this.headerLength - 4).toString('ascii')
                this.headerLength = 0
                const fields = header.split('\r\n').filter((line) => /^Content-Length:/i.test(line))
                const match = fields.length === 1 ? /^Content-Length:[ \t]*(\d+)[ \t]*$/i.exec(fields[0]) : null
                const length = match ? Number(match[1]) : NaN
                if (!Number.isSafeInteger(length) || length < 0 || length > 32 * 1024 * 1024) {
                    this.reset()
                    return
                }
                // Allocate once for the validated frame; fragmented replies no longer recopy their entire prefix.
                this.body = Buffer.allocUnsafe(length)
                this.bodyLength = 0
            }
            const size = Math.min(this.body.length - this.bodyLength, chunk.length - offset)
            chunk.copy(this.body, this.bodyLength, offset, offset + size)
            this.bodyLength += size
            offset += size
            if (this.bodyLength < this.body.length) return
            const body = this.body.toString('utf8')
            this.body = undefined
            this.bodyLength = 0
            let message: unknown
            try {
                message = JSON.parse(body)
            } catch {
                continue
            }
            this.receive(message)
        }
    }

    private reset(): void {
        this.headerLength = 0
        this.body = undefined
        this.bodyLength = 0
    }
}
