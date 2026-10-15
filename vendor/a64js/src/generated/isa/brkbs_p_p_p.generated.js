export const ENCODINGS = [
    {
        "instructionId": "brkbs_p_p_p",
        "encodingId": "brkbs_p_p_p_z",
        "mnemonic": "BRKBS",
        "className": "Setting the condition flags",
        "fileName": "brkbs_p_p_p.xml",
        "mask": 4294951440,
        "value": 634404864,
        "bitCount": 20,
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
