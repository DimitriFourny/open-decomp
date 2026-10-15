export const ENCODINGS = [
    {
        "instructionId": "pnext_p_p_p",
        "encodingId": "pnext_p_p_p_",
        "mnemonic": "PNEXT",
        "className": "SVE",
        "fileName": "pnext_p_p_p.xml",
        "mask": 4282383888,
        "value": 622445568,
        "bitCount": 22,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Pv",
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
