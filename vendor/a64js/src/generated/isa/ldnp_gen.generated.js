export const ENCODINGS = [
    {
        "instructionId": "LDNP_gen",
        "encodingId": "LDNP_32_ldstnapair_offs",
        "mnemonic": "LDNP",
        "className": "Signed offset",
        "fileName": "ldnp_gen.xml",
        "mask": 4290772992,
        "value": 675282944,
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
        "guardDiagnostics": [
            "Rt == Rt2 && c IN {Constraint_UNDEF}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rt == Rt2 && c IN {Constraint_NOP}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction"
        ],
        "operandFamilyId": "pair-load-store"
    },
    {
        "instructionId": "LDNP_gen",
        "encodingId": "LDNP_64_ldstnapair_offs",
        "mnemonic": "LDNP",
        "className": "Signed offset",
        "fileName": "ldnp_gen.xml",
        "mask": 4290772992,
        "value": 2822766592,
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
        "guardDiagnostics": [
            "Rt == Rt2 && c IN {Constraint_UNDEF}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rt == Rt2 && c IN {Constraint_NOP}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction"
        ],
        "operandFamilyId": "pair-load-store"
    }
];
