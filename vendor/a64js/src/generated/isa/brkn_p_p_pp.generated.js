export const ENCODINGS = [
    {
        "instructionId": "brkn_p_p_pp",
        "encodingId": "brkn_p_p_pp_",
        "mnemonic": "BRKN",
        "className": "Not setting the condition flags",
        "fileName": "brkn_p_p_pp.xml",
        "mask": 4294951440,
        "value": 622346240,
        "bitCount": 20,
        "fields": [
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
                "name": "Pdm",
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
        "operandFamilyId": "sve-predicate-break-propagation"
    }
];
