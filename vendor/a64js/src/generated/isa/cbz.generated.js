export const ENCODINGS = [
    {
        "instructionId": "CBZ",
        "encodingId": "CBZ_32_compbranch",
        "mnemonic": "CBZ",
        "className": "19-bit signed PC-relative branch offset",
        "fileName": "cbz.xml",
        "mask": 4278190080,
        "value": 872415232,
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
        "instructionId": "CBZ",
        "encodingId": "CBZ_64_compbranch",
        "mnemonic": "CBZ",
        "className": "19-bit signed PC-relative branch offset",
        "fileName": "cbz.xml",
        "mask": 4278190080,
        "value": 3019898880,
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
