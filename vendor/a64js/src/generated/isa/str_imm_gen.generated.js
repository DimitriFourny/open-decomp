export const ENCODINGS = [
    {
        "instructionId": "STR_imm_gen",
        "encodingId": "STR_32_ldst_immpost",
        "mnemonic": "STR",
        "className": "Post-index",
        "fileName": "str_imm_gen.xml",
        "mask": 4292873216,
        "value": 3087008768,
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
        "instructionId": "STR_imm_gen",
        "encodingId": "STR_32_ldst_immpre",
        "mnemonic": "STR",
        "className": "Pre-index",
        "fileName": "str_imm_gen.xml",
        "mask": 4292873216,
        "value": 3087010816,
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
        "instructionId": "STR_imm_gen",
        "encodingId": "STR_64_ldst_immpost",
        "mnemonic": "STR",
        "className": "Post-index",
        "fileName": "str_imm_gen.xml",
        "mask": 4292873216,
        "value": 4160750592,
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
        "instructionId": "STR_imm_gen",
        "encodingId": "STR_64_ldst_immpre",
        "mnemonic": "STR",
        "className": "Pre-index",
        "fileName": "str_imm_gen.xml",
        "mask": 4292873216,
        "value": 4160752640,
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
        "instructionId": "STR_imm_gen",
        "encodingId": "STR_32_ldst_pos",
        "mnemonic": "STR",
        "className": "Unsigned offset",
        "fileName": "str_imm_gen.xml",
        "mask": 4290772992,
        "value": 3103784960,
        "bitCount": 10,
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
                "name": "imm12",
                "lsb": 10,
                "width": 12
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
        "instructionId": "STR_imm_gen",
        "encodingId": "STR_64_ldst_pos",
        "mnemonic": "STR",
        "className": "Unsigned offset",
        "fileName": "str_imm_gen.xml",
        "mask": 4290772992,
        "value": 4177526784,
        "bitCount": 10,
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
                "name": "imm12",
                "lsb": 10,
                "width": 12
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
