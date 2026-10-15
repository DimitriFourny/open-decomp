export const ENCODINGS = [
    {
        "instructionId": "CBNZ",
        "encodingId": "CBNZ_32_compbranch",
        "mnemonic": "CBNZ",
        "className": "19-bit signed PC-relative branch offset",
        "fileName": "cbnz.xml",
        "mask": 4278190080,
        "value": 889192448,
        "bitCount": 8,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 24,
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
        "operandFamilyId": "cbz"
    },
    {
        "instructionId": "CBNZ",
        "encodingId": "CBNZ_64_compbranch",
        "mnemonic": "CBNZ",
        "className": "19-bit signed PC-relative branch offset",
        "fileName": "cbnz.xml",
        "mask": 4278190080,
        "value": 3036676096,
        "bitCount": 8,
        "fields": [
            {
                "name": "sf",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 24,
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
        "operandFamilyId": "cbz"
    }
];
