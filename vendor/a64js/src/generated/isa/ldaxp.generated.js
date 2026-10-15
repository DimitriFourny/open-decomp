export const ENCODINGS = [
    {
        "instructionId": "LDAXP",
        "encodingId": "LDAXP_LP32_ldstexclp",
        "mnemonic": "LDAXP",
        "className": "No offset",
        "fileName": "ldaxp.xml",
        "mask": 4292902912,
        "value": 2288025600,
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
            "Rt == Rt2 && c IN {Constraint_UNDEF}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rt == Rt2 && c IN {Constraint_NOP}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction"
        ],
        "operandFamilyId": "exclusive-pair"
    },
    {
        "instructionId": "LDAXP",
        "encodingId": "LDAXP_LP64_ldstexclp",
        "mnemonic": "LDAXP",
        "className": "No offset",
        "fileName": "ldaxp.xml",
        "mask": 4292902912,
        "value": 3361767424,
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
            "Rt == Rt2 && c IN {Constraint_UNDEF}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rt == Rt2 && c IN {Constraint_NOP}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction"
        ],
        "operandFamilyId": "exclusive-pair"
    }
];
