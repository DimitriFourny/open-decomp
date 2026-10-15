export const ENCODINGS = [
    {
        "instructionId": "TBZ",
        "encodingId": "TBZ_only_testbranch",
        "mnemonic": "TBZ",
        "className": "14-bit signed PC-relative branch offset",
        "fileName": "tbz.xml",
        "mask": 2130706432,
        "value": 905969664,
        "bitCount": 7,
        "fields": [
            {
                "name": "b5",
                "lsb": 31,
                "width": 1
            },
            {
                "name": "op",
                "lsb": 24,
                "width": 1
            },
            {
                "name": "b40",
                "lsb": 19,
                "width": 5
            },
            {
                "name": "imm14",
                "lsb": 5,
                "width": 14
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
        "operandFamilyId": "tbz"
    }
];
