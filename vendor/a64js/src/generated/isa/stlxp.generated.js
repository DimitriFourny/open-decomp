export const ENCODINGS = [
    {
        "instructionId": "STLXP",
        "encodingId": "STLXP_SP32_ldstexclp",
        "mnemonic": "STLXP",
        "className": "No offset",
        "fileName": "stlxp.xml",
        "mask": 4292902912,
        "value": 2283831296,
        "bitCount": 12,
        "fields": [
            {
                "name": "sz",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "o0",
                "lsb": 15,
                "width": 1
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
            "Rs == Rt || (Rs == Rt2) && c IN {Constraint_UNDEF}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rs == Rt || (Rs == Rt2) && c IN {Constraint_NOP}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rs == Rn && Rn != 31 && c IN {Constraint_UNDEF}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rs == Rn && Rn != 31 && c IN {Constraint_NOP}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction"
        ],
        "operandFamilyId": "stlxp"
    },
    {
        "instructionId": "STLXP",
        "encodingId": "STLXP_SP64_ldstexclp",
        "mnemonic": "STLXP",
        "className": "No offset",
        "fileName": "stlxp.xml",
        "mask": 4292902912,
        "value": 3357573120,
        "bitCount": 12,
        "fields": [
            {
                "name": "sz",
                "lsb": 30,
                "width": 1
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "o0",
                "lsb": 15,
                "width": 1
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
            "Rs == Rt || (Rs == Rt2) && c IN {Constraint_UNDEF}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rs == Rt || (Rs == Rt2) && c IN {Constraint_NOP}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rs == Rn && Rn != 31 && c IN {Constraint_UNDEF}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rs == Rn && Rn != 31 && c IN {Constraint_NOP}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction"
        ],
        "operandFamilyId": "stlxp"
    }
];
