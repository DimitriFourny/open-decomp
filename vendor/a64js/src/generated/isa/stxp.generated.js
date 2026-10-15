export const ENCODINGS = [
    {
        "instructionId": "STXP",
        "encodingId": "STXP_SP32_ldstexclp",
        "mnemonic": "STXP",
        "className": "No offset",
        "fileName": "stxp.xml",
        "mask": 4292902912,
        "value": 2283798528,
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
        "operandFamilyId": "exclusive-pair"
    },
    {
        "instructionId": "STXP",
        "encodingId": "STXP_SP64_ldstexclp",
        "mnemonic": "STXP",
        "className": "No offset",
        "fileName": "stxp.xml",
        "mask": 4292902912,
        "value": 3357540352,
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
        "operandFamilyId": "exclusive-pair"
    }
];
