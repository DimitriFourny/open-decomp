export const ENCODINGS = [
    {
        "instructionId": "LDR_imm_gen",
        "encodingId": "LDR_32_ldst_immpost",
        "mnemonic": "LDR",
        "className": "Post-index",
        "fileName": "ldr_imm_gen.xml",
        "mask": 4292873216,
        "value": 3091203072,
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
        "instructionId": "LDR_imm_gen",
        "encodingId": "LDR_32_ldst_immpre",
        "mnemonic": "LDR",
        "className": "Pre-index",
        "fileName": "ldr_imm_gen.xml",
        "mask": 4292873216,
        "value": 3091205120,
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
        "instructionId": "LDR_imm_gen",
        "encodingId": "LDR_64_ldst_immpost",
        "mnemonic": "LDR",
        "className": "Post-index",
        "fileName": "ldr_imm_gen.xml",
        "mask": 4292873216,
        "value": 4164944896,
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
        "instructionId": "LDR_imm_gen",
        "encodingId": "LDR_64_ldst_immpre",
        "mnemonic": "LDR",
        "className": "Pre-index",
        "fileName": "ldr_imm_gen.xml",
        "mask": 4292873216,
        "value": 4164946944,
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
        "instructionId": "LDR_imm_gen",
        "encodingId": "LDR_32_ldst_pos",
        "mnemonic": "LDR",
        "className": "Unsigned offset",
        "fileName": "ldr_imm_gen.xml",
        "mask": 4290772992,
        "value": 3107979264,
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
        "instructionId": "LDR_imm_gen",
        "encodingId": "LDR_64_ldst_pos",
        "mnemonic": "LDR",
        "className": "Unsigned offset",
        "fileName": "ldr_imm_gen.xml",
        "mask": 4290772992,
        "value": 4181721088,
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
