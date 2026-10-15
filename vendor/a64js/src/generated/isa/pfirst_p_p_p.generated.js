export const ENCODINGS = [
    {
        "instructionId": "pfirst_p_p_p",
        "encodingId": "pfirst_p_p_p_",
        "mnemonic": "PFIRST",
        "className": "SVE",
        "fileName": "pfirst_p_p_p.xml",
        "mask": 4294966800,
        "value": 626573312,
        "bitCount": 24,
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
                "name": "Pg",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "Pdn",
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
        "operandFamilyId": "sve-predicate-flow"
    }
];
