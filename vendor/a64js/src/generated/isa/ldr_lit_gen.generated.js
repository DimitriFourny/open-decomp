export const ENCODINGS = [
    {
        "instructionId": "LDR_lit_gen",
        "encodingId": "LDR_32_loadlit",
        "mnemonic": "LDR",
        "className": "Literal",
        "fileName": "ldr_lit_gen.xml",
        "mask": 4278190080,
        "value": 402653184,
        "bitCount": 8,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "imm19",
                "lsb": 5,
                "width": 19
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "ldr-literal"
    },
    {
        "instructionId": "LDR_lit_gen",
        "encodingId": "LDR_64_loadlit",
        "mnemonic": "LDR",
        "className": "Literal",
        "fileName": "ldr_lit_gen.xml",
        "mask": 4278190080,
        "value": 1476395008,
        "bitCount": 8,
        "fields": [
            {
                "name": "opc",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "imm19",
                "lsb": 5,
                "width": 19
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [],
        "featureGuards": [],
        "guards": [],
        "operandFamilyId": "ldr-literal"
    }
];
