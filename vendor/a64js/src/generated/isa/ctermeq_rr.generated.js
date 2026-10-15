export const ENCODINGS = [
    {
        "instructionId": "ctermeq_rr",
        "encodingId": "ctermeq_rr_",
        "mnemonic": "CTERMEQ",
        "className": "Equal",
        "fileName": "ctermeq_rr.xml",
        "mask": 4288740383,
        "value": 631250944,
        "bitCount": 21,
        "fields": [
            {
                "name": "op",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
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
        "operandFamilyId": "sve-terminate-condition"
    },
    {
        "instructionId": "ctermeq_rr",
        "encodingId": "ctermne_rr_",
        "mnemonic": "CTERMNE",
        "className": "Not equal",
        "fileName": "ctermeq_rr.xml",
        "mask": 4288740383,
        "value": 631250960,
        "bitCount": 21,
        "fields": [
            {
                "name": "op",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "sz",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "ne",
                "lsb": 4,
                "width": 1
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
        "operandFamilyId": "sve-terminate-condition"
    }
];
