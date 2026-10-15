export const ENCODINGS = [
    {
        "instructionId": "LDPSW",
        "encodingId": "LDPSW_64_ldstpair_off",
        "mnemonic": "LDPSW",
        "className": "Signed offset",
        "fileName": "ldpsw.xml",
        "mask": 4290772992,
        "value": 1765801984,
        "bitCount": 10,
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
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "LDPSW",
        "encodingId": "LDPSW_64_ldstpair_post",
        "mnemonic": "LDPSW",
        "className": "Post-index",
        "fileName": "ldpsw.xml",
        "mask": 4290772992,
        "value": 1757413376,
        "bitCount": 10,
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
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "LDPSW",
        "encodingId": "LDPSW_64_ldstpair_pre",
        "mnemonic": "LDPSW",
        "className": "Pre-index",
        "fileName": "ldpsw.xml",
        "mask": 4290772992,
        "value": 1774190592,
        "bitCount": 10,
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
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "imm7",
                "lsb": 15,
                "width": 7
            },
            {
                "name": "Rt2",
                "lsb": 10,
                "width": 5
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
        "operandFamilyId": "pair-load-store"
    }
];
