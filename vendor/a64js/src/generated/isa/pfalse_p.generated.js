export const ENCODINGS = [
    {
        "instructionId": "pfalse_p",
        "encodingId": "pfalse_p_",
        "mnemonic": "PFALSE",
        "className": "SVE",
        "fileName": "pfalse_p.xml",
        "mask": 4294967280,
        "value": 622388224,
        "bitCount": 28,
        "fields": [
            {
                "name": "op",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "S",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Pd",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-predicate-control"
    }
];
