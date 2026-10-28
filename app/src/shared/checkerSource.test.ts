import { expect, it } from 'vitest'
import { inspectCheckerSource } from './checkerSource'
import { N_CHECK_TEMPLATE } from './nCheck'

it('recognizes the n-check template and testlib source independently of the filename', () => {
    expect(inspectCheckerSource(N_CHECK_TEMPLATE)).toMatchObject({ kind: 'n-check', usesTestlib: false })
    expect(
        inspectCheckerSource('#include "testlib.h"\nint main(int n,char**v){registerTestlibCmd(n,v);}')
    ).toMatchObject({ kind: 'testlib', usesTestlib: true })
})

it('does not interpret commented includes or raw string examples as a protocol', () => {
    const text =
        '// #include "testlib.h"\nconst char* example=R"demo(registerInteraction(argc, argv);)demo";\nint main(){}'
    expect(inspectCheckerSource(text)).toMatchObject({ kind: 'unknown', usesTestlib: false })
    expect(inspectCheckerSource('// n-check 1\n' + text)).toMatchObject({ kind: 'n-check', usesTestlib: false })
})

it.each(['registerInteraction(argc,argv)', 'registerValidation(argc,argv)', 'registerGen(argc,argv,1)'])(
    'rejects a non-checker testlib role: %s',
    (call) => {
        expect(inspectCheckerSource('#include <testlib.h>\nint main(){' + call + ';}').kind).toBe('invalid')
    }
)

it('keeps a header requirement even when a wrapper hides the registration call', () => {
    expect(inspectCheckerSource('#include "testlib.h"\nint main(){setup();}')).toMatchObject({
        kind: 'unknown',
        usesTestlib: true
    })
})
