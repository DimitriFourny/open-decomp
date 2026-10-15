export const ENCODINGS = [
    {
        "instructionId": "rdffr_p_f",
        "encodingId": "rdffr_p_f_",
        "mnemonic": "RDFFR",
        "className": "SVE",
        "fileName": "rdffr_p_f.xml",
        "mask": 4294967280,
        "value": 622456832,
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
            "FEAT_SVE"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-rdffr"
    }
];
