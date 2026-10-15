export const ENCODINGS = [
    {
        "instructionId": "LDRSW_imm",
        "encodingId": "LDRSW_64_ldst_immpost",
        "mnemonic": "LDRSW",
        "className": "Post-index",
        "fileName": "ldrsw_imm.xml",
        "mask": 4292873216,
        "value": 3095397376,
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
        "instructionId": "LDRSW_imm",
        "encodingId": "LDRSW_64_ldst_immpre",
        "mnemonic": "LDRSW",
        "className": "Pre-index",
        "fileName": "ldrsw_imm.xml",
        "mask": 4292873216,
        "value": 3095399424,
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
        "instructionId": "LDRSW_imm",
        "encodingId": "LDRSW_64_ldst_pos",
        "mnemonic": "LDRSW",
        "className": "Unsigned offset",
        "fileName": "ldrsw_imm.xml",
        "mask": 4290772992,
        "value": 3112173568,
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
