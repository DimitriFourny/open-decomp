export const ENCODINGS = [
    {
        "instructionId": "STLR",
        "encodingId": "STLR_32S_ldapstl_writeback",
        "mnemonic": "STLR",
        "className": "Pre-index",
        "fileName": "stlr.xml",
        "mask": 4294966272,
        "value": 2575304704,
        "bitCount": 22,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
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
        "features": [
            "FEAT_LRCPC3"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_LRCPC3",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "guardDiagnostics": [
            "Rn == Rt && Rn != 31 && c IN {Constraint_UNDEF}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rn == Rt && Rn != 31 && c IN {Constraint_NOP}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction"
        ],
        "operandFamilyId": "stlr"
    },
    {
        "instructionId": "STLR",
        "encodingId": "STLR_64S_ldapstl_writeback",
        "mnemonic": "STLR",
        "className": "Pre-index",
        "fileName": "stlr.xml",
        "mask": 4294966272,
        "value": 3649046528,
        "bitCount": 22,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "L",
                "lsb": 22,
                "width": 1
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
        "features": [
            "FEAT_LRCPC3"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_LRCPC3",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "guardDiagnostics": [
            "Rn == Rt && Rn != 31 && c IN {Constraint_UNDEF}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction",
            "Rn == Rt && Rn != 31 && c IN {Constraint_NOP}: ConstrainUnpredictable selects an implementation-defined outcome; static decoding preserves the recognized instruction"
        ],
        "operandFamilyId": "stlr"
    },
    {
        "instructionId": "STLR",
        "encodingId": "STLR_SL32_ldstord",
        "mnemonic": "STLR",
        "className": "No offset",
        "fileName": "stlr.xml",
        "mask": 4292902912,
        "value": 2290122752,
        "bitCount": 12,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
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
        "operandFamilyId": "stlr"
    },
    {
        "instructionId": "STLR",
        "encodingId": "STLR_SL64_ldstord",
        "mnemonic": "STLR",
        "className": "No offset",
        "fileName": "stlr.xml",
        "mask": 4292902912,
        "value": 3363864576,
        "bitCount": 12,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
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
        "operandFamilyId": "stlr"
    }
];
