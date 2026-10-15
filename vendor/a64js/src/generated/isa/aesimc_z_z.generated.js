export const ENCODINGS = [
    {
        "instructionId": "aesimc_z_z",
        "encodingId": "aesimc_z_z_",
        "mnemonic": "AESIMC",
        "className": "SVE2",
        "fileName": "aesimc_z_z.xml",
        "mask": 4294967264,
        "value": 1159783424,
        "bitCount": 27,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "op",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zdn",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE_AES"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE_AES",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "aesmc-z-z"
    }
];
