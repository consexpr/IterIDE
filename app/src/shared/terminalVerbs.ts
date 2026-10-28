// Spinner verbs shown while a program runs, each with the past tense that replaces it afterwards.
const TABLE = [
    "Accomplishing/Accomplished Actioning/Actioned Actualizing/Actualized Baking/Baked Beboppin'/Bebopped",
    'Billowing/Billowed Bloviating/Bloviated Boogieing/Boogied Boondoggling/Boondoggled Booping/Booped',
    'Bootstrapping/Bootstrapped Brewing/Brewed Burrowing/Burrowed Calculating/Calculated Canoodling/Canoodled',
    'Caramelizing/Caramelized Cascading/Cascaded Catapulting/Catapulted Cerebrating/Cerebrated Channeling/Channeled',
    'Choreographing/Choreographed Churning/Churned Clauding/Clauded Coalescing/Coalesced Cogitating/Cogitated',
    'Combobulating/Combobulated Composing/Composed Computing/Computed Concocting/Concocted Considering/Considered',
    'Contemplating/Contemplated Cooking/Cooked Crafting/Crafted Creating/Created Crunching/Crunched',
    'Crystallizing/Crystallized Cultivating/Cultivated Deciphering/Deciphered Deliberating/Deliberated',
    'Determining/Determined Dilly-dallying/Dilly-dallied Discombobulating/Discombobulated Doing/Did',
    'Doodling/Doodled Drizzling/Drizzled Ebbing/Ebbed Effecting/Effected Elucidating/Elucidated',
    'Embellishing/Embellished Enchanting/Enchanted Envisioning/Envisioned Evaporating/Evaporated',
    'Fermenting/Fermented Fiddle-faddling/Fiddle-faddled Finagling/Finagled Flambeing/Flambeed',
    'Flibbertigibbeting/Flibbertigibbeted Flowing/Flowed Flummoxing/Flummoxed Fluttering/Fluttered',
    'Forging/Forged Forming/Formed Frolicking/Frolicked Frosting/Frosted Gallivanting/Gallivanted',
    'Galloping/Galloped Garnishing/Garnished Generating/Generated Germinating/Germinated Gitifying/Gitified',
    'Grooving/Grooved Gusting/Gusted Harmonizing/Harmonized Hashing/Hashed Hatching/Hatched Herding/Herded',
    'Honking/Honked Hullaballooing/Hullaballooed Hyperspacing/Hyperspaced Ideating/Ideated Imagining/Imagined',
    'Improvising/Improvised Incubating/Incubated Inferring/Inferred Infusing/Infused Ionizing/Ionized',
    'Jitterbugging/Jitterbugged Julienning/Julienned Kneading/Kneaded Leavening/Leavened Levitating/Levitated',
    'Lollygagging/Lollygagged Manifesting/Manifested Marinating/Marinated Meandering/Meandered',
    'Metamorphosing/Metamorphosed Misting/Misted Moonwalking/Moonwalked Moseying/Moseyed Mulling/Mulled',
    'Mustering/Mustered Musing/Mused Nebulizing/Nebulized Nesting/Nested Noodling/Noodled Nucleating/Nucleated',
    'Orbiting/Orbited Orchestrating/Orchestrated Osmosing/Osmosed Perambulating/Perambulated',
    'Percolating/Percolated Perusing/Perused Philosophising/Philosophised Photosynthesizing/Photosynthesized',
    'Pollinating/Pollinated Pondering/Pondered Pontificating/Pontificated Pouncing/Pounced',
    'Precipitating/Precipitated Prestidigitating/Prestidigitated Processing/Processed Proofing/Proofed',
    'Propagating/Propagated Puttering/Puttered Puzzling/Puzzled Quantumizing/Quantumized',
    'Razzle-dazzling/Razzle-dazzled Recombobulating/Recombobulated Reticulating/Reticulated Roosting/Roosted',
    'Ruminating/Ruminated Sauteing/Sauteed Scampering/Scampered Scheming/Schemed Schlepping/Schlepped',
    'Scurrying/Scurried Seasoning/Seasoned Shenaniganing/Shenaniganed Shimmying/Shimmied Shucking/Shucked',
    'Simmering/Simmered Skedaddling/Skedaddled Sketching/Sketched Slithering/Slithered Smooshing/Smooshed',
    'Sock-hopping/Sock-hopped Spelunking/Spelunked Spinning/Spun Sprouting/Sprouted Stewing/Stewed',
    'Sublimating/Sublimated Swirling/Swirled Swooping/Swooped Symbioting/Symbioted Synthesizing/Synthesized',
    'Tempering/Tempered Thinking/Thought Thundering/Thundered Tinkering/Tinkered Tomfoolering/Tomfoolered',
    'Topsy-turvying/Topsy-turvied Transfiguring/Transfigured Transmuting/Transmuted Twisting/Twisted',
    'Undulating/Undulated Unfurling/Unfurled Unravelling/Unravelled Vibing/Vibed Waddling/Waddled',
    'Wandering/Wandered Warping/Warped Whatchamacalliting/Whatchamacallited Whirlpooling/Whirlpooled',
    'Whirring/Whirred Whisking/Whisked Wibbling/Wibbled Working/Worked Wrangling/Wrangled Zesting/Zested',
    'Zigzagging/Zigzagged'
]

export const SPINNER_VERBS: readonly { present: string; past: string }[] = TABLE.join(' ')
    .split(' ')
    .map((pair) => {
        const [present, past] = pair.split('/')
        return { present, past }
    })
