export const ENCODINGS = [
    {
        "instructionId": "rdffrs_p_p_f",
        "encodingId": "rdffrs_p_p_f_",
        "mnemonic": "RDFFRS",
        "className": "Setting the condition flags",
        "fileName": "rdffrs_p_p_f.xml",
        "mask": 4294966800,
        "value": 626585600,
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
