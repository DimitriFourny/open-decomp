export const ENCODINGS = [
    {
        "instructionId": "brka_p_p_p",
        "encodingId": "brka_p_p_p_",
        "mnemonic": "BRKA",
        "className": "Not setting the condition flags",
        "fileName": "brka_p_p_p.xml",
        "mask": 4294951424,
        "value": 621821952,
        "bitCount": 19,
        "fields": [
            {
                "name": "B",
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
                "lsb": 10,
                "width": 4
            },
            {
                "name": "Pn",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "M",
                "lsb": 4,
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
        "operandFamilyId": "sve-predicate-break"
    }
];
