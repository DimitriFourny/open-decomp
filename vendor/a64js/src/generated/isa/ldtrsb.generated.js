export const ENCODINGS = [
    {
        "instructionId": "LDTRSB",
        "encodingId": "LDTRSB_32_ldst_unpriv",
        "mnemonic": "LDTRSB",
        "className": "Unscaled offset",
        "fileName": "ldtrsb.xml",
        "mask": 4292873216,
        "value": 952109056,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
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
        "operandFamilyId": "scalar-load-store"
    },
    {
        "instructionId": "LDTRSB",
        "encodingId": "LDTRSB_64_ldst_unpriv",
        "mnemonic": "LDTRSB",
        "className": "Unscaled offset",
        "fileName": "ldtrsb.xml",
        "mask": 4292873216,
        "value": 947914752,
        "bitCount": 13,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "imm9",
                "lsb": 12,
                "width": 9
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
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
        "operandFamilyId": "scalar-load-store"
    }
];
